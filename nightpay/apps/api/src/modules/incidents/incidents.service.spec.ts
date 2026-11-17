import { afterEach, describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { INCIDENT_QUERY_CONCURRENCY, IncidentsService } from './incidents.service';
import { AlertsService } from './alerts.service';
import { TelegramService } from './telegram.service';
import { REFUND_PENDING_MINUTES, type Incident, type PendingRefundRow } from './incident-rules';

const at = (iso: string) => new Date(iso);

/**
 * $queryRaw devuelve, en orden: atascados, dobles cobros, registros, noches,
 * revisadas, datáfono (3), devoluciones del saldo pedidas antes, banco, avisos
 * de cobro no dados por buenos, devoluciones sin confirmar y solicitudes de
 * «Por aprobar» sin decidir (y, al final, las recargas pendientes de asignar).
 */
function makeIncidents(rows: {
  stuck?: unknown[];
  dup?: unknown[];
  audit?: unknown[];
  nights?: unknown[];
  acks?: unknown[];
  posMismatch?: unknown[];
  posUnmatched?: unknown[];
  posUnreconciled?: unknown[];
  walletsToClose?: unknown[];
  bankItems?: unknown[];
  anomalies?: unknown[];
  pendingRefunds?: unknown[];
  pendingApprovals?: unknown[];
  posVoidedPaid?: unknown[];
  unprovenSales?: unknown[];
  unassignedTopUps?: unknown[];
}) {
  const prisma = {
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce(rows.stuck ?? [])
      .mockResolvedValueOnce(rows.dup ?? [])
      .mockResolvedValueOnce(rows.audit ?? [])
      .mockResolvedValueOnce(rows.nights ?? [])
      .mockResolvedValueOnce(rows.acks ?? [])
      .mockResolvedValueOnce(rows.posMismatch ?? [])
      .mockResolvedValueOnce(rows.posUnmatched ?? [])
      .mockResolvedValueOnce(rows.posUnreconciled ?? [])
      .mockResolvedValueOnce(rows.walletsToClose ?? [])
      .mockResolvedValueOnce(rows.bankItems ?? [])
      .mockResolvedValueOnce(rows.anomalies ?? [])
      .mockResolvedValueOnce(rows.pendingRefunds ?? [])
      .mockResolvedValueOnce(rows.pendingApprovals ?? [])
      .mockResolvedValueOnce(rows.posVoidedPaid ?? [])
      .mockResolvedValueOnce(rows.unprovenSales ?? [])
      .mockResolvedValueOnce(rows.unassignedTopUps ?? []),
    incidentAck: { upsert: vi.fn().mockResolvedValue({}) },
    asSystem: vi.fn(),
  };
  prisma.asSystem.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  return { svc: new IncidentsService(prisma as never, audit as never), prisma, audit };
}

describe('bandeja de incidencias — recarga pendiente de asignar', () => {
  it('cobrada sin el NFC del cliente: sale con el importe y dónde asignarla; se quita sola (no se marca)', async () => {
    const { svc, prisma } = makeIncidents({
      unassignedTopUps: [{ id: 'w-prov', balanceCents: 5_000, occurredAt: at('2026-10-17T00:30:00Z') }],
    });
    const items = await svc.list('t-1', at('2026-10-17T01:00:00Z'));
    const item = items.find((i) => i.kind === 'wallet_topup_unassigned')!;
    expect(item).toMatchObject({ refId: 'w-prov', amountCents: 5_000, ackable: false, paymentId: null });
    expect(item.detail).toContain('50,00 €');
    expect(item.detail).toMatch(/Recepción/);
    // Solo las que llevan más de 10 min sin asignar (la chica suele hacerlo al momento).
    const query = prisma.$queryRaw.mock.calls.find(([s]) => String((s as string[]).join('?')).includes('"pendingAssignAt" <'))!;
    expect(query).toContainEqual(at('2026-10-17T00:50:00Z'));
    await expect(svc.ack('t-1', 'u-1', { kind: 'wallet_topup_unassigned', refId: 'w-prov' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('bandeja de incidencias — datáfono sin la prueba de Paytef y topes de la recepción', () => {
  it('ventas por datáfono sin cuadrar con el banco: una por noche, marcable; tope de la recepción: marcable con su porqué', async () => {
    const { svc } = makeIncidents({
      unprovenSales: [{ night: '2026-10-13', count: 3, amountCents: 45_000, lastAt: at('2026-10-14T02:00:00Z') }],
      audit: [
        {
          id: '31',
          action: 'pos.reception_limit_exceeded',
          paymentId: 'term-1',
          amountCents: 99_999,
          occurredAt: at('2026-10-14T01:00:00Z'),
          payload: { limit: 'terminal_daily', terminalLabel: 'Recepción' },
        },
      ],
    });
    const items = await svc.list('t-1');
    const unproven = items.find((i) => i.kind === 'pos_unproven_sales')!;
    expect(unproven).toMatchObject({ refId: '2026-10-13', amountCents: 45_000, ackable: true, paymentId: null });
    expect(unproven.title).toBe('Ventas por datáfono sin cuadrar con el banco');
    expect(unproven.detail).toContain('3 ventas por datáfono (450,00 €)');
    // Las del camarero también, y qué hacer: la comisión está retenida hasta cuadrarlas o liberarlas.
    expect(unproven.detail).toContain('confirmó un camarero');
    expect(unproven.detail).toContain('retenida');
    const limit = items.find((i) => i.kind === 'pos_reception_limit')!;
    expect(limit).toMatchObject({ refId: '31', ackable: true, paymentId: null });
    expect(limit.detail).toContain('«Recepción» ha pasado el tope de recargas del datáfono en 24 h (pedía 999,99 €)');
  });

  it('recarga del datáfono sin comprobar: dice que NO se sumó y cómo resolverla', async () => {
    const { svc } = makeIncidents({
      anomalies: [
        {
          id: '41',
          eventType: 'payment.approval_unverified',
          paymentId: 'p-41',
          amountCents: 6_000,
          occurredAt: at('2026-10-14T01:00:00Z'),
          payload: { provider: 'PAYTEF', providerTxId: '99812', operationNumber: '99812', source: 'pos-device' },
        },
      ],
    });
    const [i] = await svc.list('t-1');
    expect(i).toMatchObject({ kind: 'approval_unverified', refId: 'p-41', title: 'Recarga del datáfono sin comprobar', ackable: false });
    expect(i!.detail).toContain('NO se ha sumado al saldo');
    expect(i!.detail).toContain('operación 99812');
  });
});

describe('bandeja de incidencias', () => {
  it('junta atascados, dobles cobros, descuentos fallidos, wallets y noches; sin las revisadas', async () => {
    const { svc } = makeIncidents({
      stuck: [{ id: 'p-1', status: 'ORPHAN', amountCents: 500, updatedAt: at('2026-10-13T21:00:00Z') }],
      dup: [{ id: '7', paymentId: 'p-2', amountCents: 10_500, occurredAt: at('2026-10-13T22:00:00Z'), payload: {} }],
      audit: [
        { id: '8', action: 'refund.earning_reverse_failed', paymentId: 'p-3', amountCents: 100, occurredAt: at('2026-10-13T20:00:00Z'), payload: {} },
        { id: '9', action: 'wallet.credit_skipped_critical', paymentId: 'p-4', amountCents: 2000, occurredAt: at('2026-10-13T19:00:00Z'), payload: {} },
      ],
      nights: [{ id: 'n-1', closedAt: at('2026-10-14T06:00:00Z'), pendingAtClose: 1, autoClosed: true }],
      acks: [{ kind: 'wallet_credit_skipped', refId: '9' }],
    });
    const items = await svc.list('t-1');
    expect(items.map((i) => i.kind)).toEqual([
      'night_closed_pending',
      'duplicate_charge',
      'stuck_payment',
      'earning_reverse_failed',
    ]);
  });

  it('datáfono: venta que no cuadra con el cobro y venta del cierre que no está en NightPay', async () => {
    const { svc } = makeIncidents({
      posMismatch: [
        {
          id: '21',
          paymentId: 'p-9',
          amountCents: null,
          occurredAt: at('2026-10-13T23:30:00Z'),
          payload: { operationNumber: '99812', message: 'El cobro ya no estaba abierto.' },
        },
      ],
      posUnmatched: [
        { id: 'op-1', paymentId: null, amountCents: 5000, occurredAt: at('2026-10-13T23:40:00Z'), payload: { operationNumber: '77' } },
      ],
    });
    const items = await svc.list('t-1');
    expect(items.map((i) => i.kind)).toEqual(['pos_unmatched_op', 'pos_charge_mismatch']);
    expect(items[0]!.detail).toContain('50,00 €');
    expect(items[1]!.detail).toContain('Operación 99812');
  });

  it('venta anulada en el datáfono que pagó el cobro, y el cobro sigue pagado (P4): incidencia marcable', async () => {
    const { svc, prisma } = makeIncidents({
      posVoidedPaid: [
        { id: '31', paymentId: 'p-8', amountCents: 12_000, occurredAt: at('2026-10-13T23:50:00Z'), payload: { operationNumber: '4410', terminalId: 'term-1' } },
      ],
    });
    const [i] = await svc.list('t-1');
    expect(i).toMatchObject({ kind: 'pos_voided_paid', refId: '31', paymentId: 'p-8', amountCents: 12_000, ackable: true });
    expect(i!.title).toBe('Venta anulada en el datáfono y el cobro sigue pagado');
    expect(i!.detail).toContain('120,00 €');
    expect(i!.detail).toContain('Operación 4410');
    expect(i!.detail).toContain('regístralo como devolución');
    // La venta anulada tiene que ser la que pagó el cobro, en ese datáfono, y el cobro seguir pagado.
    // La consulta de las ventas anuladas en el datáfono.
    const sql = prisma.$queryRaw.mock.calls
      .map((c) => (c[0] as string[]).join('?'))
      .find((s) => s.includes('JOIN payments p ON p.id = v."paymentId"'))!;
    expect(sql).toContain(`"eventType" = 'pos.voided'`);
    expect(sql).toContain(`p."posOperationNumber" = v.payload ->> 'operationNumber'`);
    expect(sql).toContain(`p."posTerminalId"::text = v.payload ->> 'terminalId'`);
    expect(sql).toContain(`p.status::text IN ('AUTHORIZED', 'PARTIALLY_REFUNDED')`);
    expect(sql).toContain(`k.kind = 'pos_voided_paid'`);
  });

  it('cobro del datáfono sin cuadrar en 24 h: se avisa y se quita solo al cuadrar', async () => {
    const { svc } = makeIncidents({
      posUnreconciled: [
        { id: 'p-7', paymentId: 'p-7', amountCents: 10_000, occurredAt: at('2026-10-12T22:00:00Z'), payload: { operationNumber: '55' } },
      ],
    });
    const [i] = await svc.list('t-1');
    expect(i).toMatchObject({ kind: 'pos_unreconciled', ackable: false, paymentId: 'p-7' });
    expect(i!.detail).toContain('Cuadrar con el datáfono');
  });

  it('saldo: una devolución pedida antes de la nueva regla (se quita sola al terminarla); el saldo que queda tras la noche ya no es aviso', async () => {
    const { svc, prisma } = makeIncidents({
      walletsToClose: [{ id: 'w-1', shortCode: 'K7Q4M2', balanceCents: 8000, occurredAt: at('2026-10-14T01:00:00Z') }],
    });
    const items = await svc.list('t-1', at('2026-10-14T09:00:00Z'));
    expect(items.map((i) => [i.kind, i.ackable])).toEqual([['wallet_close_requested', false]]);
    expect(items[0]!.detail).toContain('80,00 €');
    // El código como lo ve el cliente (con guion).
    expect(items[0]!.detail).toContain('código K7Q-4M2');
    // Ya no se busca el saldo «sin devolver» tras la noche: es para la próxima visita.
    const sql = prisma.$queryRaw.mock.calls.map(([s]) => (s as string[]).join('?'));
    expect(sql.some((q) => q.includes('"closeRequestedAt" IS NULL'))).toBe(false);
  });

  it('cuadre con el banco: cada diferencia con su explicación, y se puede marcar como revisada', async () => {
    const { svc } = makeIncidents({
      bankItems: [
        {
          id: 'bi-1',
          status: 'NOT_IN_BANK',
          kind: 'SALE',
          operationAt: at('2026-10-13T21:18:59Z'),
          source: 'REDSYS',
          bankAmountCents: null,
          oursAmountCents: 6000,
          reference: '2610MLbhyfNg',
          authCode: null,
          paymentId: 'p-1',
          occurredAt: at('2026-10-13T21:18:59Z'),
        },
        {
          id: 'bi-2',
          status: 'AMOUNT_MISMATCH',
          kind: 'SALE',
          operationAt: at('2026-10-13T22:00:00Z'),
          source: 'PAYTEF',
          bankAmountCents: 5500,
          oursAmountCents: 5000,
          reference: '000077',
          authCode: 'A1B2C3',
          paymentId: 'p-2',
          occurredAt: at('2026-10-13T22:00:00Z'),
        },
      ],
    });
    const items = await svc.list('t-1', at('2026-10-14T09:00:00Z'));
    expect(items.map((i) => [i.kind, i.title, i.ackable])).toEqual([
      ['bank_mismatch', 'Importe distinto en el banco', true],
      ['bank_mismatch', 'Cobro que el banco no tiene', true],
    ]);
    expect(items[0]!.detail).toContain('Banco 55,00 € · aquí 50,00 €');
    expect(items[0]!.detail).toContain('Datáfono (Paytef)');
    expect(items[1]!.detail).toContain('no lo pagues a la chica');
    // Identificador estable: no depende de la línea (volver a subir conserva lo revisado).
    expect(items[1]!.refId).toBe('REDSYS|NOT_IN_BANK|SALE|2610MLbhyfNg|p-1||6000|');
  });

  it('avisos de cobro aprobado no dados por buenos: uno "sin comprobar" por cobro; importe distinto aparte', async () => {
    const anomaly = (id: string, eventType: string, paymentId: string, payload: Record<string, unknown>) => ({
      id,
      eventType,
      paymentId,
      amountCents: 5000,
      occurredAt: at(`2026-10-14T0${id.slice(-1)}:00:00Z`),
      payload,
    });
    const { svc } = makeIncidents({
      anomalies: [
        anomaly('903', 'payment.approval_unverified', 'p-1', { provider: 'PEANPE', providerTxId: 'ABC123' }),
        anomaly('902', 'payment.approval_unverified', 'p-1', { provider: 'PEANPE', providerTxId: 'ABC123' }),
        anomaly('901', 'payment.amount_mismatch', 'p-2', { provider: 'REDSYS', chargedCents: 100, expectedCents: 5000 }),
      ],
    });
    const items = await svc.list('t-1', at('2026-10-14T09:00:00Z'));
    expect(items.map((i) => [i.kind, i.refId, i.ackable])).toEqual([
      ['approval_unverified', 'p-1', false],
      ['amount_mismatch', '901', true],
    ]);
  });

  it('importe distinto se marca como revisado; "sin comprobar" no (se quita al resolver el cobro)', async () => {
    const row = {
      id: '901',
      eventType: 'payment.amount_mismatch',
      paymentId: 'p-2',
      amountCents: 5000,
      occurredAt: at('2026-10-14T01:00:00Z'),
      payload: { chargedCents: 100, expectedCents: 5000 },
    };
    const ok = makeIncidents({ anomalies: [row] });
    await ok.svc.ack('t-1', 'owner', { kind: 'amount_mismatch', refId: '901', note: 'devuelto' });
    expect(ok.prisma.incidentAck.upsert).toHaveBeenCalled();
    await expect(
      makeIncidents({}).svc.ack('t-1', 'owner', { kind: 'approval_unverified', refId: 'p-1' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('marcar como revisada: solo las que no se resuelven solas y que existen en este local', async () => {
    const dup = { id: '7', paymentId: 'p-2', amountCents: 100, occurredAt: at('2026-10-13T22:00:00Z'), payload: {} };
    const ok = makeIncidents({ dup: [dup] });
    await ok.svc.ack('t-1', 'owner', { kind: 'duplicate_charge', refId: '7', note: 'devuelto en BBVA' });
    expect(ok.prisma.incidentAck.upsert).toHaveBeenCalled();
    expect(ok.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'incident.acked' }));

    await expect(makeIncidents({}).svc.ack('t-1', 'owner', { kind: 'stuck_payment', refId: 'p-1' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      makeIncidents({}).svc.ack('t-1', 'owner', { kind: 'duplicate_charge', refId: 'otro' }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('devoluciones sin confirmar (refund_pending)', () => {
  const NOW = at('2026-10-14T00:12:00Z');
  const pending = (over: Partial<PendingRefundRow> = {}): PendingRefundRow => ({
    id: 'r-1',
    paymentId: 'p-1',
    amountCents: 2500,
    paymentAmountCents: 8000,
    provider: 'PAYTEF',
    providerTxId: 'PT-7781',
    settleFailed: false,
    createdAt: at('2026-10-14T00:00:00Z'),
    ...over,
  });

  it('sale con texto para el dueño, el cobro y un refId estable (el id de la devolución)', async () => {
    const { svc } = makeIncidents({ pendingRefunds: [pending()] });
    const [i] = await svc.list('t-1', NOW);
    expect(i).toEqual({
      kind: 'refund_pending',
      refId: 'r-1',
      title: 'Devolución sin confirmar del banco',
      detail: expect.stringContaining('25,00 € del cobro de 80,00 € (pedido PT-7781), hace 12 min.'),
      occurredAt: '2026-10-14T00:00:00.000Z',
      amountCents: 2500,
      paymentId: 'p-1',
      ackable: false,
      noteRequired: false,
    });
    expect(i!.detail).toMatch(/Revisa en el panel de Paytef .*pulsa Resolver/);
    // El mismo refId en la siguiente vuelta, aunque el texto cambie ("hace 17 min").
    const { svc: later } = makeIncidents({ pendingRefunds: [pending()] });
    const [again] = await later.list('t-1', at('2026-10-14T00:17:00Z'));
    expect(again!.refId).toBe(i!.refId);
    expect(again!.detail).toContain('hace 17 min');
  });

  it('hecha en la pasarela pero sin apuntar (refund.settle_failed): pide marcarla como hecha', async () => {
    const { svc } = makeIncidents({ pendingRefunds: [pending({ settleFailed: true, provider: 'REDSYS' })] });
    const [i] = await svc.list('t-1', NOW);
    expect(i!.detail).toMatch(/El banco \(Redsys\) dice que la hizo.*Resolver → Hecha\. No la repitas\./);
  });

  it(`umbral: solo las PENDING de hace más de ${REFUND_PENDING_MINUTES} min (constante con nombre)`, async () => {
    expect(REFUND_PENDING_MINUTES).toBe(5);
    const { svc, prisma } = makeIncidents({});
    await svc.list('t-1', NOW);
    const call = prisma.$queryRaw.mock.calls.find(([strings]) =>
      (strings as TemplateStringsArray).join('?').includes('FROM refunds r'),
    ) as [TemplateStringsArray, ...unknown[]] | undefined;
    expect(call).toBeDefined();
    const sql = call![0].join('?');
    expect(sql).toContain("r.status = 'PENDING'");
    expect(sql).toMatch(/r\."createdAt" < \?/);
    expect(call!.slice(1)).toContainEqual(new Date(NOW.getTime() - REFUND_PENDING_MINUTES * 60 * 1000));
  });

  it('se quita sola al resolverla (ya no está PENDING) y no se puede marcar como revisada', async () => {
    const { svc } = makeIncidents({ pendingRefunds: [] });
    expect(await svc.list('t-1', NOW)).toEqual([]);
    await expect(makeIncidents({}).svc.ack('t-1', 'owner', { kind: 'refund_pending', refId: 'r-1' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('tiempo: minutos, luego horas y días', async () => {
    const { svc } = makeIncidents({
      pendingRefunds: [
        pending({ id: 'r-h', createdAt: at('2026-10-13T21:00:00Z') }),
        pending({ id: 'r-d', createdAt: at('2026-10-11T00:00:00Z') }),
      ],
    });
    const items = await svc.list('t-1', NOW);
    expect(items.find((i) => i.refId === 'r-h')!.detail).toContain('hace 3 h.');
    expect(items.find((i) => i.refId === 'r-d')!.detail).toContain('hace 3 días.');
  });
});

describe('alertas por Telegram', () => {
  const incident = (refId: string): Incident => ({
    kind: 'duplicate_charge',
    refId,
    title: 'El cliente pagó dos veces',
    detail: 'Devuelve uno.',
    occurredAt: '2026-10-13T22:00:00.000Z',
    amountCents: 100,
    paymentId: 'p',
    ackable: true,
  });

  function makeAlerts(
    open: Incident[],
    cobros: unknown[] = [],
    cashNights: Array<Record<string, unknown>> = [],
    alertSettings: unknown = null,
  ) {
    const claimed = new Set<string>();
    const redis = {
      exists: vi.fn().mockImplementation(async (key: string) => (claimed.has(key) ? 1 : 0)),
      set: vi.fn().mockImplementation(async (key: string) => {
        if (claimed.has(key)) return null;
        claimed.add(key);
        return 'OK';
      }),
      del: vi.fn().mockImplementation(async (key: string) => {
        claimed.delete(key);
        return 1;
      }),
    };
    const prisma = {
      venue: {
        findMany: vi.fn().mockResolvedValue([{ id: 't-1', name: 'Local Centro', alertSettings }]),
        findUnique: vi.fn().mockResolvedValue({ walletGroup: null }),
      },
      venueNight: { findMany: vi.fn().mockResolvedValue(cashNights) },
      bankStatement: { findFirst: vi.fn().mockResolvedValue(null) },
      // Ventas por datáfono retenidas de más de 24 h (bank-hold-sql.staleBankHolds): ninguna.
      $queryRaw: vi.fn().mockResolvedValue([{ count: 0, chargedCents: 0n, shareCents: 0n, oldestAt: null }]),
      asSystem: vi.fn(),
      acrossVenues: vi.fn(),
    };
    prisma.asSystem.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
    prisma.acrossVenues.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
    const incidents = { list: vi.fn().mockResolvedValue(open) };
    const reports = {
      cobros: vi.fn().mockResolvedValue(cobros),
      devoluciones: vi.fn().mockResolvedValue([]),
      liquidaciones: vi.fn().mockResolvedValue([]),
      consumos: vi.fn().mockResolvedValue([]),
      pagosSaldo: vi.fn().mockResolvedValue([]),
      recargasEfectivo: vi.fn().mockResolvedValue([]),
    };
    const telegram = {
      send: vi.fn().mockResolvedValue(true),
      isConfigured: (chatId?: string | null) => chatId !== '@sin_bot_aqui',
      hasBot: () => true,
    };
    const svc = new AlertsService(prisma as never, redis as never, incidents as never, reports as never, telegram as never);
    return { svc, telegram, reports, incidents, prisma, redis };
  }

  it('Ajustes → Avisos: un grupo apagado no sale; el resto va al chat del local', async () => {
    const pos: Incident = { ...incident('9'), kind: 'pos_unmatched_op', title: 'Venta del datáfono sin cobro' };
    const { svc, telegram } = makeAlerts([incident('1'), pos], [], [], {
      kinds: { pos: false },
      chatId: '-1001234567890',
    });
    await svc.tick(at('2026-10-13T23:00:00Z'));
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(telegram.send).toHaveBeenCalledWith(expect.stringContaining('pagó dos veces'), '-1001234567890');
  });

  it('sin nombres (lo de siempre): la solicitud de pago no lleva el nombre de la chica; con nombres, sí', async () => {
    const approval: Incident = {
      kind: 'approval_pending',
      refId: 'ap-1',
      title: 'Pago a una chica por aprobar',
      detail: 'Pedro pidió pagar 90 € a Ana hace 31 min.',
      alertDetail: 'Pedro pidió pagar 90 € a una chica hace 31 min.',
      occurredAt: '2026-10-13T22:30:00.000Z',
      amountCents: 9000,
      paymentId: null,
      ackable: false,
    };
    const anon = makeAlerts([approval]);
    await anon.svc.tick(at('2026-10-13T23:00:00Z'));
    expect(anon.telegram.send.mock.calls[0]![0]).toContain('a una chica');
    expect(anon.telegram.send.mock.calls[0]![0]).not.toContain('Ana');
    const named = makeAlerts([approval], [], [], { includeNames: true });
    await named.svc.tick(at('2026-10-13T23:00:00Z'));
    expect(named.telegram.send.mock.calls[0]![0]).toContain('a Ana');
  });

  it('el resumen de las 9:00 apagado no sale (los avisos sí)', async () => {
    const fresh: Incident = { ...incident('1'), occurredAt: '2026-10-14T07:00:00.000Z' };
    const { svc, telegram } = makeAlerts([fresh], [{ amountCents: 1000 }], [], { kinds: { summary: false } });
    await svc.tick(at('2026-10-14T07:30:00Z'));
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(telegram.send.mock.calls[0]![0]).not.toContain('anoche');
  });

  it('cada incidencia se avisa una sola vez', async () => {
    const { svc, telegram } = makeAlerts([incident('1'), incident('2')]);
    const night = at('2026-10-13T23:00:00Z'); // 01:00 de Madrid: aún no toca el resumen
    await svc.tick(night);
    await svc.tick(night);
    expect(telegram.send).toHaveBeenCalledTimes(2);
    expect(telegram.send.mock.calls[0]![0]).toContain('Local Centro');
  });

  it('devolución sin confirmar: se avisa una vez aunque el texto cambie en cada vuelta', async () => {
    const pendingRefund = (detail: string): Incident => ({
      kind: 'refund_pending',
      refId: 'r-1',
      title: 'Devolución sin confirmar del banco',
      detail,
      occurredAt: '2026-10-13T22:50:00.000Z',
      amountCents: 2500,
      paymentId: 'p-1',
      ackable: false,
    });
    const { svc, telegram, incidents } = makeAlerts([pendingRefund('… hace 10 min.')]);
    await svc.tick(at('2026-10-13T23:00:00Z'));
    incidents.list.mockResolvedValue([pendingRefund('… hace 15 min.')]);
    await svc.tick(at('2026-10-13T23:05:00Z'));
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(telegram.send.mock.calls[0]![0]).toContain('Devolución sin confirmar del banco');
  });

  it('como mucho 10 avisos por vuelta', async () => {
    const many = Array.from({ length: 15 }, (_, i) => incident(String(i)));
    const { svc, telegram } = makeAlerts(many);
    await svc.tick(at('2026-10-13T23:00:00Z'));
    expect(telegram.send).toHaveBeenCalledTimes(10);
  });

  it('a partir de las 9:00, un resumen al día de la noche anterior (08:00 a 08:00)', async () => {
    const { svc, telegram, reports } = makeAlerts([incident('1')]);
    const morning = at('2026-10-14T07:30:00Z'); // 09:30 de Madrid
    await svc.tick(morning);
    await svc.tick(morning);
    const summaries = telegram.send.mock.calls.filter(([text]) => String(text).includes('anoche'));
    expect(summaries).toHaveLength(1);
    expect(reports.cobros).toHaveBeenCalledWith('t-1', {
      from: at('2026-10-13T06:00:00Z'),
      to: at('2026-10-14T06:00:00Z'),
    });
  });

  describe('«Avisar al encargado» desde Esperando (cobro que el banco no ha confirmado)', () => {
    const stuck: Incident = {
      kind: 'stuck_payment',
      refId: 'pay-1',
      title: 'Cobro sin confirmar por el banco',
      detail: '38,30 €. Búscalo en el portal de BBVA y resuélvelo en Hoy → Cobros → Resolver.',
      occurredAt: '2026-10-13T22:00:00.000Z',
      amountCents: 3_830,
      paymentId: 'pay-1',
      ackable: false,
    };

    it('manda ya la incidencia del cobro (la de la bandeja), una sola vez: la vuelta de los avisos no la repite', async () => {
      const { svc, telegram, prisma, incidents } = makeAlerts([stuck]);
      prisma.venue.findUnique.mockResolvedValue({ id: 't-1', name: 'Local Centro', alertSettings: null });
      await expect(svc.notifyPaymentNow('t-1', 'pay-1')).resolves.toEqual({ sent: true, telegram: true });
      expect(telegram.send).toHaveBeenCalledTimes(1);
      expect(String(telegram.send.mock.calls[0]![0])).toContain('Local Centro: Cobro sin confirmar por el banco');
      // Otra vez (doble toque) o la vuelta de 5 min: ya le llegó (sin recalcular las incidencias del local).
      await expect(svc.notifyPaymentNow('t-1', 'pay-1')).resolves.toEqual({ sent: true, telegram: true });
      expect(incidents.list).toHaveBeenCalledTimes(1);
      await svc.tick(at('2026-10-13T22:10:00Z'));
      expect(telegram.send).toHaveBeenCalledTimes(1);
    });

    it('sin chat de Telegram, con los avisos de cobros apagados o sin incidencia: no se manda (sigue en el panel)', async () => {
      const noChat = makeAlerts([stuck]);
      noChat.prisma.venue.findUnique.mockResolvedValue({ id: 't-1', name: 'Local Centro', alertSettings: { chatId: '@sin_bot_aqui' } });
      await expect(noChat.svc.notifyPaymentNow('t-1', 'pay-1')).resolves.toEqual({ sent: false, telegram: false });

      const off = makeAlerts([stuck]);
      off.prisma.venue.findUnique.mockResolvedValue({ id: 't-1', name: 'Local Centro', alertSettings: { kinds: { payments: false } } });
      await expect(off.svc.notifyPaymentNow('t-1', 'pay-1')).resolves.toEqual({ sent: false, telegram: true });

      const other = makeAlerts([{ ...stuck, refId: 'pay-2', paymentId: 'pay-2' }]);
      other.prisma.venue.findUnique.mockResolvedValue({ id: 't-1', name: 'Local Centro', alertSettings: null });
      await expect(other.svc.notifyPaymentNow('t-1', 'pay-1')).resolves.toEqual({ sent: false, telegram: true });
      expect([noChat, off, other].every((x) => x.telegram.send.mock.calls.length === 0)).toBe(true);
    });
  });

  describe('recordatorio de ventas por datáfono sin cuadrar (comisión retenida)', () => {
    const stale = [{ count: 2, chargedCents: 40_000n, shareCents: 36_000n, oldestAt: at('2026-10-12T23:00:00Z') }];
    const bankHold = (calls: unknown[][]) => calls.filter(([text]) => String(text).includes('sin cuadrar con el banco'));

    it('una vez al día por local, desde las 9:00 de Madrid, con lo cobrado y lo retenido (sin nombres)', async () => {
      const { svc, telegram, prisma, redis } = makeAlerts([]);
      prisma.$queryRaw.mockResolvedValue(stale);
      await svc.tick(at('2026-10-14T06:30:00Z')); // 08:30: aún no
      expect(bankHold(telegram.send.mock.calls)).toHaveLength(0);
      await svc.tick(at('2026-10-14T07:30:00Z')); // 09:30
      await svc.tick(at('2026-10-14T12:30:00Z')); // y otra vuelta del mismo día
      const sent = bankHold(telegram.send.mock.calls);
      expect(sent).toHaveLength(1);
      expect(String(sent[0]![0])).toContain('Local Centro: 2 ventas por datáfono sin cuadrar con el banco desde hace más de 24 h (400,00 € cobrados)');
      expect(String(sent[0]![0])).toContain('(360,00 €) está retenida');
      expect(redis.set).toHaveBeenCalledWith('np:bankhold:t-1:2026-10-14', '1', 'EX', expect.any(Number), 'NX');
      // Las de más de 24 h: el corte va 24 h antes de la vuelta; ya enviado, la vuelta siguiente ni consulta.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const before = prisma.$queryRaw.mock.calls.at(-1)!.slice(1).find((v: unknown) => v instanceof Date) as Date | undefined;
      expect(before?.toISOString()).toBe('2026-10-13T07:30:00.000Z');
      // Al día siguiente, otra vez.
      await svc.tick(at('2026-10-15T07:30:00Z'));
      expect(bankHold(telegram.send.mock.calls)).toHaveLength(2);
    });

    it('sin ventas retenidas de más de 24 h, o con los avisos del datáfono apagados, nada', async () => {
      const quiet = makeAlerts([]);
      await quiet.svc.tick(at('2026-10-14T07:30:00Z'));
      expect(bankHold(quiet.telegram.send.mock.calls)).toHaveLength(0);

      const off = makeAlerts([], [], [], { kinds: { pos: false } });
      off.prisma.$queryRaw.mockResolvedValue(stale);
      await off.svc.tick(at('2026-10-14T07:30:00Z'));
      expect(bankHold(off.telegram.send.mock.calls)).toHaveLength(0);
    });

    it('si falla, el resumen de las 9:00 sale igual', async () => {
      const { svc, telegram, prisma } = makeAlerts([incident('1')]);
      prisma.$queryRaw.mockRejectedValue(new Error('base caída'));
      await svc.tick(at('2026-10-14T07:30:00Z'));
      expect(telegram.send.mock.calls.filter(([text]) => String(text).includes('anoche'))).toHaveLength(1);
    });
  });

  it('si Telegram falla, se reintenta en la siguiente vuelta (no se pierde)', async () => {
    const { svc, telegram } = makeAlerts([incident('1')]);
    telegram.send.mockResolvedValueOnce(false);
    const night = at('2026-10-13T23:00:00Z');
    await svc.tick(night);
    await svc.tick(night);
    await svc.tick(night);
    expect(telegram.send).toHaveBeenCalledTimes(2);
  });

  it('incidencias de hace más de 6 horas no se avisan (siguen en la bandeja)', async () => {
    const { svc, telegram } = makeAlerts([incident('viejo')]);
    await svc.tick(at('2026-10-14T05:00:00Z')); // 7 h después, aún antes de las 9:00
    expect(telegram.send).not.toHaveBeenCalled();
  });

  it('pasadas las 14:00 ya no se manda el resumen de la mañana', async () => {
    const { svc, telegram } = makeAlerts([], [{}]);
    await svc.tick(at('2026-10-14T13:00:00Z')); // 15:00 de Madrid
    expect(telegram.send).not.toHaveBeenCalled();
  });

  it('el resumen dice la diferencia de caja de las noches cerradas en ese tramo (las 08:00 entran)', async () => {
    const { svc, telegram, prisma } = makeAlerts([], [], [
      { closedAt: at('2026-10-14T03:00:00Z'), autoClosed: false, cashDiffCents: -1250, zReport: null },
    ]);
    await svc.tick(at('2026-10-14T07:30:00Z'));
    // Sin cobros ni incidencias, pero la caja no cuadró: el dueño lo sabe.
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(telegram.send.mock.calls[0]![0]).toContain('Caja: faltan 12,50 €');
    expect(prisma.venueNight.findMany).toHaveBeenCalledWith({
      where: { tenantId: 't-1', closedAt: { gt: at('2026-10-13T06:00:00Z'), lte: at('2026-10-14T06:00:00Z') } },
      orderBy: { closedAt: 'asc' },
      select: { closedAt: true, autoClosed: true, cashDiffCents: true, zReport: true },
    });
  });

  it('ya enviado hoy: las vueltas siguientes ni calculan los informes (antes, cada 5 min hasta las 14:00) (DI-03)', async () => {
    const { svc, telegram, reports, redis } = makeAlerts([incident('1')]);
    await svc.tick(at('2026-10-14T07:30:00Z'));
    expect(reports.cobros).toHaveBeenCalledTimes(1);
    await svc.tick(at('2026-10-14T07:35:00Z'));
    await svc.tick(at('2026-10-14T07:40:00Z'));
    expect(reports.cobros).toHaveBeenCalledTimes(1);
    expect(redis.exists).toHaveBeenCalledWith('np:summary:t-1:2026-10-14');
    expect(telegram.send.mock.calls.filter(([text]) => String(text).includes('anoche'))).toHaveLength(1);
  });

  it('con la noche cerrada, el resumen es su Z congelado (como el panel → Noches) y lo dice; sin recalcular (DIN-4)', async () => {
    const z = {
      count: 2, grossCents: 5_000, tipsCents: 500, chargedCents: 5_500, refundsCount: 0, refundsCents: 0, netCents: 5_500,
      walletCardTopUpsCount: 0, walletCardTopUpsCents: 0, byType: [], chicaCommissionCents: 0, chicaTipsCents: 0,
      chicaReversalsCents: 0, chicaNetCents: 2_000, venueTipsCents: 0, venueNetCents: 3_500, payoutsCount: 0,
      payoutsCents: 0, perChica: [], walletCashPayoutsCount: 0, walletCashPayoutsCents: 0, walletCardPayoutsCount: 0,
      walletCardPayoutsCents: 0, consumptionsCount: 0, consumptionsCents: 0, saldoByType: [],
    };
    // Cerrada a mano a las 05:00 de Madrid.
    const { svc, telegram, reports } = makeAlerts([], [], [
      { closedAt: at('2026-10-14T03:00:00Z'), autoClosed: false, cashDiffCents: null, zReport: { summary: z } },
    ]);
    await svc.tick(at('2026-10-14T07:30:00Z'));
    expect(reports.cobros).not.toHaveBeenCalled();
    const text = String(telegram.send.mock.calls[0]![0]);
    expect(text).toContain('anoche: el Z de la noche cerrada a las 05:00');
    expect(text).toContain('Cobrado: 55,00 € (50,00 € de ventas con tarjeta + 5,00 € de propinas con tarjeta)');
    expect(text).toContain('Con tarjeta: 2 pagos · 55,00 €');
  });

  it('local sin cobros ni incidencias: no manda resumen', async () => {
    const { svc, telegram } = makeAlerts([]);
    await svc.tick(at('2026-10-14T07:30:00Z'));
    expect(telegram.send).not.toHaveBeenCalled();
  });
});

describe('Telegram', () => {
  afterEach(() => vi.unstubAllGlobals());

  const config = (token?: string, chat?: string) => ({
    get: (k: string) => (k === 'TELEGRAM_BOT_TOKEN' ? token : k === 'TELEGRAM_CHAT_ID' ? chat : undefined),
  });

  it('sin token o chat no envía nada', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const t = new TelegramService(config(undefined, '123') as never);
    expect(t.isConfigured()).toBe(false);
    expect(await t.send('hola')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('envía al chat del dueño; si Telegram falla, no rompe nada', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('down'));
    vi.stubGlobal('fetch', fetchMock);
    const t = new TelegramService(config('TOKEN', '123') as never);
    expect(await t.send('hola')).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]! as [string, { body: string }];
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    expect(JSON.parse(init.body)).toMatchObject({ chat_id: '123', text: 'hola' });
    expect(await t.send('otra')).toBe(false);
  });

  it('chat propio del local (Ajustes → Avisos): con bot basta, aunque no haya chat por defecto', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const t = new TelegramService(config('TOKEN') as never);
    expect(t.hasBot()).toBe(true);
    expect(t.isConfigured()).toBe(false);
    expect(t.isConfigured('-1001234567890')).toBe(true);
    expect(await t.send('hola', '-1001234567890')).toBe(true);
    expect(JSON.parse((fetchMock.mock.calls[0]! as [string, { body: string }])[1].body)).toMatchObject({ chat_id: '-1001234567890' });
  });
});

describe('bandeja de incidencias — consultas a la base (DI-04)', () => {
  it('como mucho 4 a la vez (antes las 17 a la vez: 17 conexiones del pool en cada vuelta de 5 min por local)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let total = 0;
    const query = vi.fn(async () => {
      inFlight += 1;
      total += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return [];
    });
    const prisma = { $queryRaw: query, asSystem: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ $queryRaw: query })) };
    const svc = new IncidentsService(prisma as never, { log: vi.fn() } as never);
    await expect(svc.list('t-1', at('2026-10-17T01:00:00Z'))).resolves.toEqual([]);
    // 16: el saldo que queda tras la noche ya no se busca (es para la próxima visita).
    expect(total).toBe(16);
    expect(maxInFlight).toBeLessThanOrEqual(INCIDENT_QUERY_CONCURRENCY);
    expect(INCIDENT_QUERY_CONCURRENCY).toBe(4);
  });

  it('un fallo en una consulta hace fallar la bandeja (como antes): no se enseña una bandeja a medias', async () => {
    const query = vi.fn().mockResolvedValue([]).mockRejectedValueOnce(new Error('connection terminated'));
    const prisma = { $queryRaw: query, asSystem: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ $queryRaw: query })) };
    const svc = new IncidentsService(prisma as never, { log: vi.fn() } as never);
    await expect(svc.list('t-1', at('2026-10-17T01:00:00Z'))).rejects.toThrow('connection terminated');
  });
});

describe('cerrar un aviso de dinero pide nota (B11)', () => {
  const dup = { id: '7', paymentId: 'p-2', amountCents: 100, occurredAt: at('2026-10-13T22:00:00Z'), payload: {} };
  const lost = { id: '12', action: 'wallet.card_blocked_by_client', paymentId: null, amountCents: 5000, occurredAt: at('2026-10-13T22:00:00Z'), payload: {} };

  it('sin nota, o con menos de 3 letras, no se cierra y no se apunta nada', async () => {
    for (const note of [undefined, '', '  ok  '.slice(2, 3)]) {
      const t = makeIncidents({ dup: [dup] });
      await expect(t.svc.ack('t-1', 'owner', { kind: 'duplicate_charge', refId: '7', ...(note === undefined ? {} : { note }) })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'INCIDENT_NOTE_REQUIRED' }),
      });
      expect(t.prisma.incidentAck.upsert).not.toHaveBeenCalled();
      expect(t.audit.log).not.toHaveBeenCalled();
    }
  });

  it('con nota, se cierra y la nota queda en el registro', async () => {
    const t = makeIncidents({ dup: [dup] });
    await t.svc.ack('t-1', 'owner', { kind: 'duplicate_charge', refId: '7', note: 'devuelto en BBVA' });
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ payload: { note: 'devuelto en BBVA' } }));
  });

  it('un aviso que no es de dinero se cierra sin nota', async () => {
    const t = makeIncidents({ audit: [lost] });
    await t.svc.ack('t-1', 'owner', { kind: 'wallet_card_lost', refId: '12' });
    expect(t.prisma.incidentAck.upsert).toHaveBeenCalled();
  });

  it('la bandeja dice en cada aviso si pide nota', async () => {
    const items = await makeIncidents({ dup: [dup], audit: [lost] }).svc.list('t-1', at('2026-10-14T01:00:00Z'));
    expect(items.map((i) => [i.kind, i.noteRequired])).toEqual([
      ['duplicate_charge', true],
      ['wallet_card_lost', false],
    ]);
  });
});

describe('recepción: «El cliente dice que no ha sido él» (app del personal)', () => {
  const row = { id: 'a-21', paymentId: 'charge-1', amountCents: 1_200, occurredAt: at('2026-11-17T00:10:00Z'), payload: { ref: 'C-0042', code: 'K7Q-4M2' } };
  function make(rows: unknown[]) {
    const query = vi.fn(async () => rows);
    const prisma = { $queryRaw: query, incidentAck: { upsert: vi.fn(async () => ({})) } };
    const audit = { log: vi.fn(async () => undefined) };
    return { svc: new IncidentsService(prisma as never, audit as never), prisma, audit, query };
  }

  it('solo los «No he sido yo» del local sin cerrar, y piden nota', async () => {
    const t = make([row]);
    const items = await t.svc.disputedCharges('t-1', at('2026-11-17T01:00:00Z'));
    expect(items).toEqual([expect.objectContaining({ kind: 'wallet_charge_disputed', refId: 'a-21', amountCents: 1_200, noteRequired: true })]);
    const sql = (t.query.mock.calls[0] as unknown as [string[]])[0].join('?');
    expect(sql).toContain("a.action = 'wallet.charge_disputed_by_client'");
    expect(sql).toContain("k.kind = 'wallet_charge_disputed'");
  });

  it('se cierra con su nota (como en el panel); sin nota no, y uno que no está, 404', async () => {
    const t = make([row]);
    await expect(t.svc.ackDisputed('t-1', 'rocio', { refId: 'a-21' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'INCIDENT_NOTE_REQUIRED' }) });
    await t.svc.ackDisputed('t-1', 'rocio', { refId: 'a-21', note: 'Era suyo: pagó la copa de su amiga' });
    expect(t.prisma.incidentAck.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ tenantId: 't-1', kind: 'wallet_charge_disputed', refId: 'a-21', ackedBy: 'rocio' }),
    }));
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'incident.acked', targetId: 'wallet_charge_disputed:a-21' }));
    await expect(make([]).svc.ackDisputed('t-1', 'rocio', { refId: 'a-21', note: 'nota' })).rejects.toMatchObject({ status: 404 });
  });
});
