import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { MAX_EXPORT_ROWS, ReportsService } from './reports.service';

/**
 * Lecturas del informe de la gestoría y del Z de la noche (SQL crudo). Se
 * comprueba la consulta que llega a Postgres: local explícito, límites de la
 * ventana como parámetros, el «tal como estaba» del Z (asOf), los ajustes de
 * noches anteriores y el tope de filas.
 */

const TENANT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/** Noche del martes 13-oct en Sala Bambú (Madrid): abre a las 22:00 y cierra a las 06:00 (UTC+2). */
const NIGHT = { from: new Date('2026-10-13T20:00:00Z'), to: new Date('2026-10-14T04:00:00Z') };
/** El Z de esa noche se generó a las 06:05 de Madrid. */
const Z_AT = new Date('2026-10-14T04:05:00Z');

interface Recorded {
  q: Prisma.Sql;
  /** Local con el que se abrió la transacción (null = consulta directa, sin withTenant). */
  viaTenant: string | null;
}

/** Prisma de mentira: guarda cada consulta y devuelve las filas que diga `rowsFor`. */
function makeService(rowsFor: (q: Prisma.Sql) => unknown[] = () => [], venue: { name: string } | null = null) {
  const calls: Recorded[] = [];
  const raw = (viaTenant: string | null) =>
    vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = Prisma.sql(strings, ...values);
      calls.push({ q, viaTenant });
      return rowsFor(q);
    });
  const prisma = {
    $queryRaw: raw(null),
    venue: { findUnique: vi.fn().mockResolvedValue(venue) },
    withTenant: vi.fn(async (tenantId: string, fn: (tx: unknown) => unknown) => fn({ $queryRaw: raw(tenantId) })),
  };
  return { svc: new ReportsService(prisma as never), calls, prisma };
}

/** Texto de la consulta con los parámetros en su sitio (fechas en ISO, el local como <local>). */
function render(q: Prisma.Sql): string {
  const label = (v: unknown): string =>
    v instanceof Date ? `<${v.toISOString()}>` : v === TENANT ? '<local>' : `<${String(v)}>`;
  return q.text.replace(/\$(\d+)/g, (_, i: string) => label(q.values[Number(i) - 1])).replace(/\s+/g, ' ');
}

/** Cada tabla leída va filtrada por el local, con el local como parámetro (nada del middleware). */
function expectTenantScoped(q: Prisma.Sql): void {
  const tables: Array<[string, string]> = [
    ['payments p', 'p."tenantId" = $'],
    ['refunds r', 'r."tenantId" = $'],
    ['wallet_payouts wp', 'wp."tenantId" = $'],
    ['wallet_consumptions c', 'c."tenantId" = $'],
    ['operator_payouts po', 'po."tenantId" = $'],
  ];
  for (const [from, filter] of tables) {
    if (reads(q.text, from)) expect(q.text).toContain(filter);
  }
  expect(q.values).toContain(TENANT);
}

/** ¿Lee la consulta esta tabla con este alias? («refunds r», no la subconsulta «refunds rf»). */
function reads(text: string, tableAndAlias: string): boolean {
  return new RegExp(`FROM ${tableAndAlias}\\b`).test(text);
}

const dates = (q: Prisma.Sql): Date[] => q.values.filter((v): v is Date => v instanceof Date);
const PAID_AT = 'COALESCE(p."authorizedAt", p."createdAt")';
const REFUND_AT = 'COALESCE(r."bankRefundedAt", r."createdAt")';
const iso = (d: Date): string => `<${d.toISOString()}>`;

describe('nombre del local', () => {
  it('lee el nombre del local pedido; si no existe, cadena vacía', async () => {
    const { svc, prisma } = makeService(() => [], { name: 'Sala Bambú (Madrid)' });
    expect(await svc.venueName(TENANT)).toBe('Sala Bambú (Madrid)');
    expect(prisma.venue.findUnique).toHaveBeenCalledWith({ where: { id: TENANT }, select: { name: true } });
    const vacio = makeService(() => [], null);
    expect(await vacio.svc.venueName(TENANT)).toBe('');
  });
});

describe('cobros de un periodo', () => {
  it('cobros pagados por la hora del banco en [desde, hasta), del local y dentro de su transacción', async () => {
    const fila = { id: 'b2a1c0d9-0000-4000-8000-000000000001', amountCents: 5000, tipCents: 1000, refundedCents: 0 };
    const { svc, calls } = makeService(() => [fila]);
    const rows = await svc.cobros(TENANT, NIGHT);
    expect(rows).toEqual([fila]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.viaTenant).toBe(TENANT);
    const sql = render(calls[0]!.q);
    expect(sql).toContain(`p."tenantId" = <local>::uuid AND p.status IN ('AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED')`);
    expect(sql).toContain(`${PAID_AT} >= ${iso(NIGHT.from)} AND ${PAID_AT} < ${iso(NIGHT.to)}`);
    expect(sql).toContain(`LIMIT <${MAX_EXPORT_ROWS + 1}>`);
    // Sin asOf: lo que haya ahora, sin mirar cuándo se apuntó.
    expect(sql).not.toContain('payment_events');
    expect(dates(calls[0]!.q)).toEqual([NIGHT.from, NIGHT.to]);
    expectTenantScoped(calls[0]!.q);
  });

  it('Z de la noche (asOf): solo lo que ya constaba como pagado al generar el Z', async () => {
    const { svc, calls } = makeService();
    await svc.cobros(TENANT, NIGHT, { recordedBefore: Z_AT });
    const sql = render(calls[0]!.q);
    expect(sql).toContain('SELECT MIN(pe."occurredAt") FROM payment_events pe');
    expect(sql).toContain(`pe."eventType" IN ('payment.authorized', 'payment.pos_confirmed')`);
    expect(sql).toMatch(new RegExp(`\\) < ${iso(Z_AT).replace(/[.]/g, '\\.')} ORDER BY "paidAt" ASC`));
    expect(dates(calls[0]!.q)).toEqual([NIGHT.from, NIGHT.to, Z_AT]);
  });

  it('las sumas llegan como número (::int en el SQL), y las filas pasan tal cual', async () => {
    const { svc, calls } = makeService();
    await svc.cobros(TENANT, NIGHT);
    const sql = render(calls[0]!.q);
    expect(sql).toContain('COALESCE(r.refunded, 0)::int AS "refundedCents"');
    expect(sql).toMatch(/\), 0\)::int AS "reversedAfterPayoutCents"/);
    // Lo devuelto: solo devoluciones hechas de ESE cobro.
    expect(sql).toContain(`WHERE rf."paymentId" = p.id AND rf.status = 'SUCCEEDED'`);
  });
});

describe('consumos del saldo', () => {
  it('sin asOf: solo los no anulados, por la hora del consumo', async () => {
    const { svc, calls } = makeService();
    await svc.consumos(TENANT, NIGHT);
    expect(calls[0]!.viaTenant).toBe(TENANT);
    const sql = render(calls[0]!.q);
    expect(sql).toContain(
      `c."tenantId" = <local>::uuid AND c."reversedAt" IS NULL AND c."createdAt" >= ${iso(NIGHT.from)} AND c."createdAt" < ${iso(NIGHT.to)}`,
    );
    expectTenantScoped(calls[0]!.q);
  });

  it('Z de la noche: un consumo anulado DESPUÉS del Z aún cuenta (su anulación es ajuste del siguiente)', async () => {
    const { svc, calls } = makeService();
    await svc.consumos(TENANT, NIGHT, { recordedBefore: Z_AT });
    expect(render(calls[0]!.q)).toContain(
      `(c."reversedAt" IS NULL OR c."reversedAt" >= ${iso(Z_AT)}) AND c."createdAt" >= ${iso(NIGHT.from)}`,
    );
  });
});

describe('devoluciones', () => {
  it('por el día de la devolución en el banco (no el del cobro); con asOf, solo las apuntadas antes del Z', async () => {
    const { svc, calls } = makeService();
    await svc.devoluciones(TENANT, NIGHT);
    await svc.devoluciones(TENANT, NIGHT, { recordedBefore: Z_AT });
    const [sin, con] = calls.map((c) => render(c.q));
    expect(sin).toContain(`r."tenantId" = <local>::uuid AND r.status = 'SUCCEEDED'`);
    expect(sin).toContain(`${REFUND_AT} >= ${iso(NIGHT.from)} AND ${REFUND_AT} < ${iso(NIGHT.to)} ORDER BY`);
    expect(con).toContain(`${REFUND_AT} < ${iso(NIGHT.to)} AND r."createdAt" < ${iso(Z_AT)}`);
    expect(con).toContain('(p."amountCents" + p."tipCents")::int AS "chargedCents"');
    calls.forEach((c) => {
      expect(c.viaTenant).toBe(TENANT);
      expectTenantScoped(c.q);
    });
  });
});

describe('ajustes de noches anteriores en el Z de esta noche', () => {
  /** Z del miércoles 14: el anterior se generó a las 06:05 del 14; esta noche abrió a las 22:00 del 14. */
  const ADJ = {
    before: new Date('2026-10-14T20:00:00Z'),
    since: Z_AT,
    until: new Date('2026-10-15T04:10:00Z'),
  };

  it('cobros pagados tarde, devoluciones apuntadas y consumos anulados desde el Z anterior, con fecha anterior a esta noche', async () => {
    const cobro = { id: 'c-tarde', amountCents: 8000, tipCents: 0 };
    const devolucion = { id: 'r-tarde', amountCents: 2000 };
    const anulado = { id: 'wc-anulado', amountCents: 1500 };
    const { svc, calls } = makeService((q) =>
      reads(q.text, 'payments p') ? [cobro] : reads(q.text, 'refunds r') ? [devolucion] : [anulado],
    );
    const out = await svc.ajustes(TENANT, ADJ);
    expect(out).toEqual({ cobros: [cobro], devoluciones: [devolucion], consumosAnulados: [anulado] });
    expect(calls).toHaveLength(3);

    const sql = calls.map((c) => render(c.q));
    const cobros = sql.find((s) => reads(s, 'payments p'))!;
    expect(cobros).toContain(
      `pe."tenantId" = <local>::uuid AND pe."eventType" IN ('payment.authorized', 'payment.pos_confirmed') ` +
        `AND pe."occurredAt" >= ${iso(ADJ.since)} AND pe."occurredAt" < ${iso(ADJ.until)}`,
    );
    expect(cobros).toMatch(new RegExp(`\\) >= ${iso(ADJ.since).replace(/[.]/g, '\\.')} AND COALESCE`));
    expect(cobros).toContain(`AND ${PAID_AT} < ${iso(ADJ.before)}`);

    const devoluciones = sql.find((s) => reads(s, 'refunds r'))!;
    expect(devoluciones).toContain(
      `r."createdAt" >= ${iso(ADJ.since)} AND r."createdAt" < ${iso(ADJ.until)} AND ${REFUND_AT} < ${iso(ADJ.before)}`,
    );

    const consumos = sql.find((s) => reads(s, 'wallet_consumptions c'))!;
    expect(consumos).toContain(
      `c."reversedAt" >= ${iso(ADJ.since)} AND c."reversedAt" < ${iso(ADJ.until)} AND c."createdAt" < ${iso(ADJ.before)}`,
    );

    calls.forEach((c) => {
      expect(c.viaTenant).toBe(TENANT);
      expectTenantScoped(c.q);
    });
  });

  it('si una de las tres listas pasa del tope, error en vez de un Z incompleto', async () => {
    const muchas = new Array<unknown>(MAX_EXPORT_ROWS + 1).fill({ id: 'x' });
    const { svc } = makeService((q) => (reads(q.text, 'wallet_consumptions c') ? muchas : []));
    await expect(svc.ajustes(TENANT, ADJ)).rejects.toThrow(BadRequestException);
  });
});

describe('saldo devuelto y pagos a chicas', () => {
  it('saldo devuelto: solo los hechos (DONE) del local en la ventana', async () => {
    const pago = { id: 'wp-1', at: new Date('2026-10-14T01:30:00Z'), amountCents: 8000, method: 'CASH' };
    const { svc, calls } = makeService(() => [pago]);
    expect(await svc.pagosSaldo(TENANT, NIGHT)).toEqual([pago]);
    expect(calls[0]!.viaTenant).toBeNull();
    expect(render(calls[0]!.q)).toContain(
      `wp."tenantId" = <local>::uuid AND wp."status" = 'DONE' AND wp."createdAt" >= ${iso(NIGHT.from)} AND wp."createdAt" < ${iso(NIGHT.to)}`,
    );
    expectTenantScoped(calls[0]!.q);
  });

  it('pagos a chicas: del local, por fecha del pago, con el número de partes como entero', async () => {
    const { svc, calls } = makeService();
    await svc.liquidaciones(TENANT, NIGHT);
    expect(calls[0]!.viaTenant).toBe(TENANT);
    const sql = render(calls[0]!.q);
    expect(sql).toContain(
      `po."tenantId" = <local>::uuid AND po."createdAt" >= ${iso(NIGHT.from)} AND po."createdAt" < ${iso(NIGHT.to)}`,
    );
    expect(sql).toContain('::int AS "earningCount"');
    expect(sql).toContain(`LIMIT <${MAX_EXPORT_ROWS + 1}>`);
    expectTenantScoped(calls[0]!.q);
  });
});

describe('tope de filas por informe', () => {
  const lecturas: Array<[string, (s: ReportsService) => Promise<unknown[]>]> = [
    ['cobros', (s) => s.cobros(TENANT, NIGHT)],
    ['consumos', (s) => s.consumos(TENANT, NIGHT)],
    ['devoluciones', (s) => s.devoluciones(TENANT, NIGHT)],
    ['pagosSaldo', (s) => s.pagosSaldo(TENANT, NIGHT)],
    ['liquidaciones', (s) => s.liquidaciones(TENANT, NIGHT)],
  ];

  it.each(lecturas)('%s: justo el tope se devuelve entero; una fila más → 400', async (_, leer) => {
    const justo = makeService(() => new Array<unknown>(MAX_EXPORT_ROWS).fill({ id: 'x' }));
    expect(await leer(justo.svc)).toHaveLength(MAX_EXPORT_ROWS);
    const pasado = makeService(() => new Array<unknown>(MAX_EXPORT_ROWS + 1).fill({ id: 'x' }));
    await expect(leer(pasado.svc)).rejects.toThrow(BadRequestException);
    await expect(leer(pasado.svc)).rejects.toThrow(/periodo/);
  });
});
