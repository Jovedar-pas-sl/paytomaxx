import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { PaymentsService, type LockedPaymentRow } from './payments.service';
import { InvalidTransitionError, type PaymentEvent } from './payment.machine';

/**
 * Dinero de la chica al pagarse un cobro: transition() con SQL crudo
 * simulado. Se comprueba lo que se ESCRIBE (texto + parámetros de cada
 * UPDATE/INSERT), lo que se emite por tiempo real y que nada se escribe si
 * la transición no procede.
 */

const TENANT = '5b0c8f7e-2d1a-4c3b-9e8f-0a1b2c3d4e5f';
const OTHER_TENANT = 'e4d3c2b1-a0f9-4e8d-8c7b-6a5f4e3d2c1b';
const PAYMENT_ID = '7f1c2a9e-3b4d-4e5f-8a6b-1c2d3e4f5a6b';
const OPERATOR = 'a7b6c5d4-e3f2-4a1b-9c8d-7e6f5a4b3c2d';
const BENEFICIARY = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';
const OWNER = 'c0ffee00-1234-4abc-8def-0123456789ab';
const WAITER = 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f7a';
const WALLET = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';

const USERS: Record<string, { role: string; commissionBps: number | null }> = {
  [OPERATOR]: { role: 'OPERATOR', commissionBps: null },
  [BENEFICIARY]: { role: 'OPERATOR', commissionBps: null },
  [OWNER]: { role: 'OWNER', commissionBps: null },
  [WAITER]: { role: 'WAITER', commissionBps: null },
};

function lockedRow(o: Partial<LockedPaymentRow> = {}): LockedPaymentRow {
  return {
    id: PAYMENT_ID,
    tenantId: TENANT,
    status: 'AUTHORIZING',
    amountCents: 10_000,
    availableAmountCents: 10_000,
    providerTxId: '2610170130A1',
    provider: 'REDSYS',
    createdByUserId: OPERATOR,
    walletId: null,
    tipCents: 0,
    tipGoesTo: null,
    tipBeneficiaryUserId: null,
    revenueCategory: 'CHICA_SERVICE',
    operatorCommissionBps: null,
    ...o,
  };
}

interface FakeDb {
  locked: LockedPaymentRow | null;
  /** Propina del intento que aprobó el banco (undefined = no consta). */
  attemptTip?: number;
  venueDefaults?: Record<string, number> | null;
  wallet?: Record<string, unknown>;
  /** Devoluciones: ya aplicada / ganancia de la chica (applyRefundToEarning). */
  reversalApplied?: boolean;
  earning?: Record<string, unknown>;
  /** Líneas del cobro (el mapa del dinero); sin ellas, un cobro de antes. */
  lines?: Array<{ category: string; amountCents: number; operatorCommissionBps: number | null }>;
}

function makeService(db: FakeDb) {
  const reads: Prisma.Sql[] = [];
  const writes: Prisma.Sql[] = [];
  const creatorRole = db.locked?.createdByUserId ? (USERS[db.locked.createdByUserId]?.role ?? null) : null;
  const tx = {
    $executeRawUnsafe: vi.fn(async () => 0),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = Prisma.sql(strings, ...values);
      reads.push(q);
      if (q.text.includes('FROM payments') && q.text.includes('FOR UPDATE')) return db.locked ? [db.locked] : [];
      if (q.text.includes('FROM payment_attempts')) {
        return db.attemptTip === undefined ? [] : [{ tipCents: db.attemptTip, creatorRole }];
      }
      if (q.text.includes('FROM users')) {
        const id = q.values[0] as string;
        return USERS[id] ? [{ id, ...USERS[id] }] : [];
      }
      if (q.text.includes('FROM venues')) return [{ operatorCommissionDefaults: db.venueDefaults ?? null }];
      if (q.text.includes('FROM payment_lines')) return db.lines ?? [];
      if (q.text.includes('FROM client_wallets') && q.text.includes('FOR UPDATE')) {
        return db.wallet && q.values[0] === db.wallet.id ? [db.wallet] : [];
      }
      if (q.text.includes('FROM earning_reversals WHERE "refundId"')) return db.reversalApplied ? [{ id: 'rev-1' }] : [];
      if (q.text.includes('FROM operator_earnings e')) return db.earning ? [db.earning] : [];
      return [];
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      writes.push(Prisma.sql(strings, ...values));
      return 1;
    }),
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const realtime = { emitPaymentUpdate: vi.fn(), emitPaymentCompleted: vi.fn() };
  const metrics = { paymentsTransitioned: { inc: vi.fn() }, walletCreditSkipped: { inc: vi.fn() } };
  const service = new PaymentsService(
    prisma as never,
    { get: () => ({ traceId: 'trace-comision-1' }) } as never,
    {} as never,
    {} as never,
    {} as never,
    realtime as never,
    metrics as never,
    {} as never,
    {} as never,
  );
  Object.assign(service, { logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  const written = (fragment: string) => writes.filter((w) => w.text.includes(fragment));
  return { service, prisma, reads, writes, written, realtime, metrics };
}

const authorized: PaymentEvent = { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: '2610170130A1' };

/** Parámetros de cada INSERT en operator_earnings. */
const earnings = (written: (f: string) => Prisma.Sql[]) =>
  written('INSERT INTO operator_earnings').map((w) => w.values);

describe('transition AUTHORIZED — comisión de la chica que cobró', () => {
  it.each([
    // importe, % (bps), comisión: Math.round, nunca floor
    [4_505, 9_000, 4_055], // 4.054,5 → 4.055 (medio céntimo hacia arriba)
    [3_335, 1_500, 500], // 500,25 → 500
    [999, 3_333, 333], // 332,97 → 333
  ])('%i cents al %i bps → %i cents de comisión', async (amountCents, bps, commissionCents) => {
    const { service, written } = makeService({
      locked: lockedRow({ amountCents, availableAmountCents: amountCents, operatorCommissionBps: bps }),
    });
    await service.transition(PAYMENT_ID, authorized, TENANT);
    // tenant, chica, cobro, importe, bps, comisión, propina
    expect(earnings(written)).toEqual([[TENANT, OPERATOR, PAYMENT_ID, amountCents, bps, commissionCents, 0]]);
  });

  it('sin % propio de la chica → el del local para sus servicios; el fijado al crear manda', async () => {
    const venue = makeService({ locked: lockedRow(), venueDefaults: { CHICA_SERVICE: 8_500 } });
    await venue.service.transition(PAYMENT_ID, authorized, TENANT);
    expect(earnings(venue.written)[0]!.slice(3)).toEqual([10_000, 8_500, 8_500, 0]);
    // El % del local se lee del local del cobro.
    const venueRead = venue.reads.find((r) => r.text.includes('FROM venues'))!;
    expect(venueRead.values).toEqual([TENANT]);

    const snapshot = makeService({ locked: lockedRow({ operatorCommissionBps: 7_000 }), venueDefaults: { CHICA_SERVICE: 8_500 } });
    await snapshot.service.transition(PAYMENT_ID, authorized, TENANT);
    expect(earnings(snapshot.written)[0]!.slice(3)).toEqual([10_000, 7_000, 7_000, 0]);
  });

  it('cobro de barra con 0 % y sin propina → no se apunta ganancia; con propina para ella, solo la propina', async () => {
    const bar = lockedRow({ revenueCategory: 'VENUE_BAR' });
    const noTip = makeService({ locked: bar, attemptTip: 0 });
    await noTip.service.transition(PAYMENT_ID, authorized, TENANT);
    expect(earnings(noTip.written)).toEqual([]);

    const withTip = makeService({ locked: bar, attemptTip: 300 });
    await withTip.service.transition(PAYMENT_ID, authorized, TENANT);
    expect(earnings(withTip.written)).toEqual([[TENANT, OPERATOR, PAYMENT_ID, 10_000, 0, 0, 300]]);
  });

  it('propina para la chica que cobró: entera a su ganancia; la comisión solo sobre el importe', async () => {
    const { service, written, realtime } = makeService({ locked: lockedRow(), attemptTip: 1_500 });
    await service.transition(PAYMENT_ID, authorized, TENANT);
    expect(earnings(written)).toEqual([[TENANT, OPERATOR, PAYMENT_ID, 10_000, 9_000, 9_000, 1_500]]);
    // Devolvible: importe + propina cobrada.
    expect(written('SET status')[0]!.values.slice(0, 2)).toEqual(['AUTHORIZED', 11_500]);
    expect(realtime.emitPaymentCompleted).toHaveBeenCalledWith(PAYMENT_ID, 'AUTHORIZED', 1_500);
  });

  it('propina para el local → la chica solo se lleva la comisión; para ella como beneficiaria → también la propina', async () => {
    const venue = makeService({ locked: lockedRow({ tipGoesTo: 'venue' }), attemptTip: 1_500 });
    await venue.service.transition(PAYMENT_ID, authorized, TENANT);
    expect(earnings(venue.written)[0]!.slice(-2)).toEqual([9_000, 0]);

    const herself = makeService({
      locked: lockedRow({ tipGoesTo: 'beneficiary', tipBeneficiaryUserId: OPERATOR }),
      attemptTip: 1_500,
    });
    await herself.service.transition(PAYMENT_ID, authorized, TENANT);
    expect(earnings(herself.written)).toEqual([[TENANT, OPERATOR, PAYMENT_ID, 10_000, 9_000, 9_000, 1_500]]);
  });
});

describe('transition AUTHORIZED — comisión por línea (el mapa del dinero)', () => {
  it('pack «1 h con habitación»: su % solo sobre la parte de Servicios', async () => {
    const { service, written } = makeService({
      locked: lockedRow({ amountCents: 15_000, availableAmountCents: 15_000, operatorCommissionBps: 7_200 }),
      lines: [
        { category: 'CHICA_SERVICE', amountCents: 12_000, operatorCommissionBps: 9_000 },
        { category: 'VENUE_ROOM', amountCents: 3_000, operatorCommissionBps: 0 },
      ],
    });
    await service.transition(PAYMENT_ID, authorized, TENANT);
    // 90 % de 120 € = 108 €; el % que se guarda es el efectivo sobre los 150 €.
    expect(earnings(written)).toEqual([[TENANT, OPERATOR, PAYMENT_ID, 15_000, 7_200, 10_800, 0]]);
  });

  it('REGRESIÓN: un cobro de una sola sección con su línea da lo mismo que sin líneas', async () => {
    for (const [amountCents, bps] of [
      [4_505, 9_000],
      [3_335, 1_500],
      [999, 3_333],
    ] as const) {
      const before = makeService({ locked: lockedRow({ amountCents, availableAmountCents: amountCents, operatorCommissionBps: bps }) });
      await before.service.transition(PAYMENT_ID, authorized, TENANT);
      const withLine = makeService({
        locked: lockedRow({ amountCents, availableAmountCents: amountCents, operatorCommissionBps: bps }),
        lines: [{ category: 'CHICA_SERVICE', amountCents, operatorCommissionBps: bps }],
      });
      await withLine.service.transition(PAYMENT_ID, authorized, TENANT);
      expect(earnings(withLine.written)).toEqual(earnings(before.written));
    }
  });

  it('línea sin % guardado: el de ahora para su sección (Servicios: el de la chica o el del local)', async () => {
    const { service, written } = makeService({
      locked: lockedRow({ amountCents: 12_000, availableAmountCents: 12_000 }),
      venueDefaults: { CHICA_SERVICE: 8_000, VENUE_BAR: 1_000 },
      lines: [
        { category: 'CHICA_SERVICE', amountCents: 10_000, operatorCommissionBps: null },
        { category: 'VENUE_BAR', amountCents: 2_000, operatorCommissionBps: null },
      ],
    });
    await service.transition(PAYMENT_ID, authorized, TENANT);
    // 80 % de 100 € + 10 % de 20 € = 82 €.
    expect(earnings(written)[0]!.slice(3)).toEqual([12_000, 6_833, 8_200, 0]);
  });

  it('cobro de la chica solo de secciones del local al 0 %: sin ganancia (como hoy en barra)', async () => {
    const { service, written } = makeService({
      locked: lockedRow({ revenueCategory: 'VENUE_ROOM' }),
      lines: [{ category: 'VENUE_ROOM', amountCents: 10_000, operatorCommissionBps: 0 }],
    });
    await service.transition(PAYMENT_ID, authorized, TENANT);
    expect(earnings(written)).toEqual([]);
  });
});

describe('transition AUTHORIZED — propina para otra persona del local', () => {
  const forBeneficiary = (createdByUserId: string | null, beneficiary: string) =>
    lockedRow({
      createdByUserId,
      amountCents: 12_000,
      availableAmountCents: 12_000,
      revenueCategory: 'VENUE_BAR',
      tipGoesTo: 'beneficiary',
      tipBeneficiaryUserId: beneficiary,
    });

  it('el dueño cobra y la propina es para una chica → ganancia solo de propina para ella', async () => {
    const { service, written } = makeService({ locked: forBeneficiary(OWNER, BENEFICIARY), attemptTip: 2_000 });
    await service.transition(PAYMENT_ID, authorized, TENANT);
    const rows = written('INSERT INTO operator_earnings');
    expect(rows).toHaveLength(1);
    // tenant, chica beneficiaria, cobro, importe, propina (bps y comisión van a 0 en el SQL).
    expect(rows[0]!.values).toEqual([TENANT, BENEFICIARY, PAYMENT_ID, 12_000, 2_000]);
    expect(rows[0]!.text).toMatch(/0::int,\s*0::int/);
  });

  it('cobro sin creador (cobro antiguo) y propina para una chica → también le llega', async () => {
    const { service, written } = makeService({ locked: forBeneficiary(null, BENEFICIARY), attemptTip: 2_000 });
    await service.transition(PAYMENT_ID, authorized, TENANT);
    expect(earnings(written)).toEqual([[TENANT, BENEFICIARY, PAYMENT_ID, 12_000, 2_000]]);
  });

  it('beneficiario que no es chica (camarero) → no se apunta ninguna ganancia', async () => {
    const { service, written } = makeService({ locked: forBeneficiary(OWNER, WAITER), attemptTip: 2_000 });
    await service.transition(PAYMENT_ID, authorized, TENANT);
    expect(earnings(written)).toEqual([]);
  });
});

describe('transition AUTHORIZED — recarga de saldo', () => {
  it('sin ganancia para la chica; al saldo solo el importe (la propina no es saldo gastable)', async () => {
    const wallet = {
      id: WALLET,
      tenantId: TENANT,
      walletGroup: null,
      balanceCents: 2_000,
      status: 'ACTIVE',
      mergedIntoId: null,
      shortCode: 'K7Q4M2',
    };
    const { service, written, reads } = makeService({
      locked: lockedRow({ walletId: WALLET, revenueCategory: 'EXTRA', amountCents: 5_000, availableAmountCents: 5_000 }),
      attemptTip: 500,
      wallet,
    });
    await service.transition(PAYMENT_ID, authorized, TENANT);
    expect(written('UPDATE client_wallets').map((w) => w.values)).toEqual([[5_000, 'K7Q4M2', WALLET]]);
    expect(earnings(written)).toEqual([]);
    // H3: el saldo que se bloquea es del local del cobro.
    const lock = reads.find((r) => r.text.includes('FROM client_wallets') && r.text.includes('FOR UPDATE'))!;
    expect(lock.text).toContain('"tenantId" = $');
    expect(lock.values).toEqual([WALLET, TENANT]);
  });
});

describe('transition — cuando no procede no se escribe nada', () => {
  it('cobro de otro local → 404 (no se revela que existe), sin escribir ni emitir', async () => {
    const { service, writes, realtime, metrics } = makeService({ locked: lockedRow(), attemptTip: 500 });
    await expect(service.transition(PAYMENT_ID, authorized, OTHER_TENANT)).rejects.toBeInstanceOf(NotFoundException);
    expect(writes).toEqual([]);
    expect(realtime.emitPaymentUpdate).not.toHaveBeenCalled();
    expect(metrics.paymentsTransitioned.inc).not.toHaveBeenCalled();
  });

  it('cobro que no existe → 404', async () => {
    const { service, writes } = makeService({ locked: null });
    await expect(service.transition(PAYMENT_ID, authorized)).rejects.toBeInstanceOf(NotFoundException);
    expect(writes).toEqual([]);
  });

  it('el FSM rechaza el evento (caducado que recibe un pagado, pagado que recibe cancelar) → sin UPDATE/INSERT ni aviso', async () => {
    const expired = makeService({ locked: lockedRow({ status: 'EXPIRED' }) });
    const err = await expired.service.transition(PAYMENT_ID, authorized, TENANT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidTransitionError);
    expect(err).toMatchObject({ fromState: 'EXPIRED', eventType: 'AUTHORIZED' });
    expect(expired.writes).toEqual([]);
    expect(expired.realtime.emitPaymentUpdate).not.toHaveBeenCalled();
    expect(expired.realtime.emitPaymentCompleted).not.toHaveBeenCalled();

    const paid = makeService({ locked: lockedRow({ status: 'AUTHORIZED' }) });
    await expect(paid.service.transition(PAYMENT_ID, { type: 'CANCELED' }, TENANT)).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    expect(paid.writes).toEqual([]);
  });
});

describe('transition — estado guardado y aviso en tiempo real', () => {
  it.each<[string, PaymentEvent, string, boolean]>([
    ['AUTHORIZING', authorized, 'AUTHORIZED', true],
    ['AUTHORIZING', { type: 'FAILED', reason: 'denegada-por-el-banco' }, 'FAILED', true],
    ['CREATED', { type: 'TIMEOUT' }, 'EXPIRED', true],
    ['CREATED', { type: 'CANCELED', reason: 'user-canceled' }, 'CANCELED', true],
    ['CREATED', { type: 'AUTHORIZING' }, 'AUTHORIZING', false],
    ['AUTHORIZING', { type: 'TIMEOUT' }, 'ORPHAN', false],
    ['AUTHORIZED', { type: 'REFUND_PARTIAL', amountCents: 1_000 }, 'PARTIALLY_REFUNDED', false],
  ])('%s + %o → %s (aviso de «terminado»: %s)', async (from, event, to, completed) => {
    const locked = lockedRow({ status: from as LockedPaymentRow['status'], createdByUserId: null });
    const { service, written, realtime, metrics } = makeService({ locked });
    await service.transition(PAYMENT_ID, event, TENANT);

    expect(written('SET status')[0]!.values[0]).toBe(to);
    const evt = written('INSERT INTO payment_events')[0]!.values;
    expect(evt.slice(0, 3)).toEqual([PAYMENT_ID, TENANT, `payment.${event.type.toLowerCase()}`]);
    expect(JSON.parse(evt[3] as string)).toEqual(event);
    expect(metrics.paymentsTransitioned.inc).toHaveBeenCalledWith({ from, to });
    expect(realtime.emitPaymentUpdate).toHaveBeenCalledWith(PAYMENT_ID, to, 10_000);
    if (completed) expect(realtime.emitPaymentCompleted).toHaveBeenCalledWith(PAYMENT_ID, to, 0);
    else expect(realtime.emitPaymentCompleted).not.toHaveBeenCalled();
  });

  it('devolución parcial: lo devolvible baja en lo devuelto', async () => {
    const { service, written } = makeService({ locked: lockedRow({ status: 'AUTHORIZED', createdByUserId: null }) });
    await service.transition(PAYMENT_ID, { type: 'REFUND_PARTIAL', amountCents: 2_500 }, TENANT);
    expect(written('SET status')[0]!.values.slice(0, 2)).toEqual(['PARTIALLY_REFUNDED', 7_500]);
  });
});

describe('applyRefundToEarning — sin nada que descontar', () => {
  const REFUND = '6e5d4c3b-2a19-4f8e-8d7c-6b5a4f3e2d1c';

  it('devolución de 0 € → ni se abre la transacción', async () => {
    const { service, prisma } = makeService({ locked: null });
    await service.applyRefundToEarning(PAYMENT_ID, REFUND, 0);
    expect(prisma.asSystem).not.toHaveBeenCalled();
  });

  it('la misma devolución otra vez (reintento) → no descuenta dos veces', async () => {
    const { service, writes } = makeService({ locked: null, reversalApplied: true, earning: { id: 'e-1' } });
    await service.applyRefundToEarning(PAYMENT_ID, REFUND, 1_000);
    expect(writes).toEqual([]);
  });

  it('cobro sin ganancia de chica (lo cobró el camarero) → nada que descontar', async () => {
    const { service, writes } = makeService({ locked: null });
    await service.applyRefundToEarning(PAYMENT_ID, REFUND, 1_000);
    expect(writes).toEqual([]);
  });
});
