// Integración (Postgres real): el panel del organizador de OxioParty (party-panel.service).
// Una noche con cobros de verdad (cobro con tarjeta de una caseta, cobro único pagado con la
// pulsera NFC, cobro del saldo con QR de otra caseta, uno sin pagar), una devolución, un consumo
// anulado, recargas con tarjeta en taquilla, desde el móvil y en efectivo, y saldo devuelto en
// efectivo. En directo cuenta lo vendido sin contar dos veces (el cobro único, una sola vez; las
// recargas no son venta), la caja de la taquilla, la liquidación por caseta y su fichero SEPA, todo
// con FORCE RLS de verdad (dentro de withTenant) y sin ver nada de otro local. np_app. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PartyLiveQuerySchema, PartySettlementQuerySchema, type JwtPayload } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { StallsService } from '../../src/modules/party/stalls.service';
import { PartyPanelService } from '../../src/modules/party/party-panel.service';
import { AuditService } from '../../src/modules/audit/audit.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const noop = () => undefined;
const audit = { log: vi.fn(async () => undefined) };
const queue = { add: vi.fn(async () => undefined) };
const metrics = { paymentsCreated: { inc: noop }, paymentsTransitioned: { inc: noop }, walletCreditSkipped: { inc: noop }, duplicateCharges: { inc: noop } };
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  { emitPaymentUpdate: noop, emitPaymentCompleted: noop } as never,
  metrics as never,
  {} as never,
  {} as never,
);
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => ({}) } as never, {} as never);
const stalls = new StallsService(prisma, { assertIfEnrolledForUser: vi.fn(async () => undefined) } as never, audit as never);
// El registro de verdad: las descargas del fichero SEPA se miran en audit_events.
const panel = new PartyPanelService(prisma, new AuditService(prisma, cls as never));

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't-party-panel' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
const STALL_IBAN = 'ES9121000418450200051332';
const VENUE_IBAN = 'ES7921000813610123456789';
let V: string, OTHER: string, terminal: string, owner: string, toni: string, maria: string, pepe: string, lucia: string;
let A: string, B: string, C: string;
let n = 0;
const key = () => `pp-${r}-${(n += 1)}`;
const ownerJwt = (): JwtPayload => ({ sub: owner, email: `org-${r}@x.es`, role: 'OWNER', tenantId: V, venueSlug: `pp-${r}` });
const staff = (userId: string) => ({ userId, role: 'WAITER' as const, tenantId: V });

function code6(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}

/** Un saldo del local (con su pulsera NFC si `nfc`). */
async function wallet(venueId: string, balanceCents: number, nfc = false): Promise<{ id: string; card: string; uid: string }> {
  n += 1;
  const card = randomBytes(16).toString('base64url');
  const uid = randomBytes(7).toString('hex').toUpperCase();
  const id = await sys(async (tx) => {
    const w = await tx.clientWallet.create({
      data: { tenantId: venueId, balanceCents, qrToken: `pp-${r}-${n}-abcdefgh`, shortCode: code6(), walletGroup: `gpp-${r}-${venueId.slice(0, 4)}` },
    });
    if (nfc) await tx.walletCard.create({ data: { token: card, uid, walletId: w.id, status: 'ISSUED', venueId } });
    return w.id;
  });
  return { id, card, uid };
}

/** Una recarga con tarjeta ya pagada (por la taquilla, o sin persona: desde el móvil). */
async function cardTopUp(walletId: string, amountCents: number, by: string | null, idempotencyKey = key()): Promise<void> {
  await sys((tx) =>
    tx.payment.create({
      data: {
        tenantId: V,
        terminalId: terminal,
        createdByUserId: by,
        idempotencyKey,
        amountCents,
        availableAmountCents: amountCents,
        status: 'AUTHORIZED',
        authorizedAt: new Date(),
        qrToken: `pp-qr-${randomBytes(8).toString('hex')}`,
        qrExpiresAt: new Date(Date.now() + 300_000),
        walletId,
        captureMethod: 'WALLET_TOPUP',
      },
    }),
  );
}

let cardSale: string;

beforeAll(async () => {
  await prisma.onModuleInit();
  vi.stubEnv('EDITION', 'party');
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Fiestas de San Juan', slug: `pp-${r}`, walletGroup: `gpp-${r}`, settlementIban: VENUE_IBAN, settlementHolder: 'Comisión de Fiestas' } })).id;
    OTHER = (await tx.venue.create({ data: { name: 'Otra fiesta', slug: `pp-otra-${r}` } })).id;
    terminal = (await tx.terminal.create({ data: { tenantId: V, externalId: `PP-${r}`, label: 'Barra', zone: 'BARRA' } })).id;
    await tx.gatewayCredential.create({
      data: { tenantId: V, provider: 'REDSYS', encKey: Buffer.from('k'), encNonce: Buffer.from('n'), encTag: Buffer.from('t'), kekVersion: 1 },
    });
    owner = (await tx.user.create({ data: { tenantId: V, email: `org-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
    toni = (await tx.user.create({ data: { tenantId: V, email: `toni-${r}@x.es`, passwordHash: 'x', role: 'WAITER', displayName: 'Toni' } })).id;
    maria = (await tx.user.create({ data: { tenantId: V, email: `maria-${r}@x.es`, passwordHash: 'x', role: 'WAITER', displayName: 'María' } })).id;
    pepe = (await tx.user.create({ data: { tenantId: V, email: `pepe-${r}@x.es`, passwordHash: 'x', role: 'WAITER', displayName: 'Pepe' } })).id;
    lucia = (await tx.user.create({ data: { tenantId: V, email: `lucia-${r}@x.es`, passwordHash: 'x', role: 'WAITER', displayName: 'Lucía' } })).id;
  });
  // Las casetas y su personal, con el servicio de verdad (FORCE RLS, dentro de withTenant).
  A = (await inVenue(V, () => stalls.create(ownerJwt(), { name: 'Peña El Trago', managerName: 'Lola', organizerBps: 1000, iban: STALL_IBAN }))).id;
  B = (await inVenue(V, () => stalls.create(ownerJwt(), { name: 'Barra de la Comisión', managerName: 'La comisión', organizerBps: 10_000 }))).id;
  C = (await inVenue(V, () => stalls.create(ownerJwt(), { name: 'Churrería', managerName: 'Paqui', organizerBps: 800 }))).id;
  await inVenue(V, () => stalls.assign(ownerJwt(), toni, { stallId: A }));
  await inVenue(V, () => stalls.assign(ownerJwt(), maria, { stallId: B }));
  await inVenue(V, () => stalls.assign(ownerJwt(), pepe, { stallId: C }));

  // a) Cobro con tarjeta de la Peña: 10 € + 1 € de propina + 1,20 € de comisión del servicio (de OxioPay).
  const a = await inVenue(V, () =>
    payments.create(V, key(), { currency: 'EUR', terminalExternalId: `PP-${r}`, amountCents: 1000, revenueCategory: 'VENUE_BAR' } as never, {
      userId: toni,
      role: 'WAITER',
    }),
  );
  cardSale = a.id;
  await sys((tx) =>
    tx.payment.update({
      where: { id: a.id },
      data: { status: 'PARTIALLY_REFUNDED', authorizedAt: new Date(), tipCents: 100, serviceFeeBps: 1200, serviceFeeCents: 120, availableAmountCents: 890 },
    }),
  );
  // …y se devuelven 3,30 € (0,30 € de comisión del servicio): la venta baja 3 €.
  await sys((tx) =>
    tx.refund.create({
      data: { tenantId: V, paymentId: a.id, amountCents: 330, serviceFeeCents: 30, requestedBy: owner, status: 'SUCCEEDED', bankRefundedAt: new Date() },
    }),
  );

  // b) Cobro único de la Peña pagado con la pulsera: el cobro con tarjeta se cancela y cuenta su consumo (una vez).
  const w1 = await wallet(V, 5_000, true);
  const unico = await inVenue(V, () =>
    payments.create(V, key(), { currency: 'EUR', terminalExternalId: `PP-${r}`, amountCents: 1000, revenueCategory: 'VENUE_BAR', withSaldo: true } as never, {
      userId: toni,
      role: 'WAITER',
    }),
  );
  await inVenue(V, () => charges.payQrChargeWithCard(staff(toni), unico.saldo!.chargeId, { card: w1.card, uid: w1.uid }));

  // c) Cobro del saldo con QR de la Barra de la Comisión, pagado con otra pulsera.
  const w2 = await wallet(V, 2_000, true);
  const qr = await inVenue(V, () => charges.createQrCharge(staff(maria), { amountCents: 800, category: 'VENUE_BAR' } as never));
  await inVenue(V, () => charges.payQrChargeWithCard(staff(maria), qr.id, { card: w2.card, uid: w2.uid }));

  // d) Un consumo anulado (no cuenta) y un cobro de la Churrería sin pagar (no cuenta).
  const w3 = await wallet(V, 700);
  await sys((tx) =>
    tx.walletConsumption.create({
      data: { tenantId: V, walletId: w3.id, amountCents: 500, providedByUserId: toni, category: 'VENUE_BAR', stallId: A, reversedAt: new Date(), reversedByUserId: owner },
    }),
  );
  await inVenue(V, () =>
    payments.create(V, key(), { currency: 'EUR', terminalExternalId: `PP-${r}`, amountCents: 1500, revenueCategory: 'VENUE_BAR' } as never, {
      userId: pepe,
      role: 'WAITER',
    }),
  );

  // e) Recargas: 50 € con tarjeta en la taquilla de Lucía, 20 € desde el móvil y 30 € (+3 € de comisión) en efectivo; Lucía devuelve 4 € en efectivo.
  const wT = await wallet(V, 5_000);
  await cardTopUp(wT.id, 5_000, lucia);
  const wP = await wallet(V, 2_000);
  await cardTopUp(wP.id, 2_000, null, `wcasa:${randomBytes(16).toString('hex')}`);
  const wC = await wallet(V, 2_600);
  await sys(async (tx) => {
    await tx.walletCashTopUp.create({
      data: { tenantId: V, walletId: wC.id, amountCents: 3_000, takenByUserId: lucia, idempotencyKey: key(), serviceFeeBps: 1000, serviceFeeCents: 300 },
    });
    await tx.walletPayout.create({ data: { tenantId: V, walletId: wC.id, amountCents: 400, method: 'CASH', paidByUserId: lucia, status: 'DONE' } });
  });

  // Otro local: lo suyo no se ve aquí.
  const wo = await wallet(OTHER, 9_999);
  await sys(async (tx) => {
    const otherUser = (await tx.user.create({ data: { tenantId: OTHER, email: `otro-${r}@x.es`, passwordHash: 'x', role: 'WAITER' } })).id;
    await tx.walletConsumption.create({ data: { tenantId: OTHER, walletId: wo.id, amountCents: 9_999, providedByUserId: otherUser, category: 'VENUE_BAR' } });
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

describe('en directo (la noche de ahora)', () => {
  it('vendido = cobros + consumos − devoluciones, sin contar dos veces el cobro único ni las recargas', async () => {
    const live = await inVenue(V, () => panel.live(V, PartyLiveQuerySchema.parse({})));
    // 11 € (cobro con propina, sin la comisión) + 10 € (cobro único, por su consumo) + 8 € − 3 € devueltos.
    expect(live.sold).toEqual({ totalCents: 1100 + 1000 + 800 - 300, count: 3, refundedCents: 300 });
    expect(live.loaded).toEqual({ totalCents: 10_000, cashCents: 3_000, cardCents: 5_000, phoneCents: 2_000, count: 3 });
    expect(live.inWristbandsCents).toBe(4_000 + 1_200 + 700 + 5_000 + 2_000 + 2_600);
    expect(live.activeWristbands).toBe(6);
    expect(live.live).toBe(true);
    expect(live.hourly.reduce((a, h) => a + h.soldCents, 0)).toBe(2_600);
  });

  it('por caseta: lo vendido, los cobros y el último; la Churrería, sin cobros aún', async () => {
    const live = await inVenue(V, () => panel.live(V, PartyLiveQuerySchema.parse({})));
    expect(live.stalls.map((s) => [s.name, s.soldCents, s.count, s.lastAt !== null, s.ownBar])).toEqual([
      ['Peña El Trago', 1800, 2, true, false],
      ['Barra de la Comisión', 800, 1, true, true],
      ['Churrería', 0, 0, false, false],
    ]);
  });

  it('las taquillas: la de Lucía (efectivo, tarjeta y su caja) y desde el móvil', async () => {
    const live = await inVenue(V, () => panel.live(V, PartyLiveQuerySchema.parse({})));
    expect(live.desks).toEqual([
      { key: `person:${lucia}`, kind: 'person', name: 'Lucía', cashCents: 3_000, cardCents: 5_000, cashInDeskCents: 2_900, count: 2 },
      { key: 'phone', kind: 'phone', name: 'Desde el móvil', cashCents: 0, cardCents: 2_000, cashInDeskCents: 0, count: 1 },
    ]);
  });

  it('el aviso de efectivo con el umbral del local; la fiesta entera también lo cuenta todo (sin avisos)', async () => {
    await sys((tx) => tx.venue.update({ where: { id: V }, data: { cashAlertCents: 2_500 } }));
    try {
      const live = await inVenue(V, () => panel.live(V, PartyLiveQuerySchema.parse({})));
      expect(live.alerts).toEqual([{ kind: 'CASH_OVER', deskKey: `person:${lucia}`, name: 'Lucía', cashCents: 2_900, thresholdCents: 2_500 }]);
      const all = await inVenue(V, () => panel.live(V, PartyLiveQuerySchema.parse({ scope: 'event' })));
      expect(all.sold.totalCents).toBe(2_600);
      expect(all.alerts).toEqual([]);
    } finally {
      await sys((tx) => tx.venue.update({ where: { id: V }, data: { cashAlertCents: 200_000 } }));
    }
  });

  it('la caja de la taquilla de Lucía (y la de quien no cobró nada, a 0)', async () => {
    expect(await inVenue(V, () => panel.cashDesk(V, lucia))).toMatchObject({
      cashInCents: 3_300,
      topUpsCount: 1,
      cashOutCents: 400,
      payoutsCount: 1,
      cashCents: 2_900,
      overAlert: false,
    });
    expect(await inVenue(V, () => panel.cashDesk(V, toni))).toMatchObject({ cashInCents: 0, cashOutCents: 0, cashCents: 0 });
  });
});

describe('la liquidación por caseta', () => {
  it('vendido, parte del organizador y lo que se le paga; barra propia y sin ventas', async () => {
    const s = await inVenue(V, () => panel.settlement(V, PartySettlementQuerySchema.parse({})));
    // En el orden de las casetas (aquí todas con el mismo: por nombre).
    expect(s.rows.map((x) => [x.name, x.soldCents, x.organizerCents, x.toPayCents, x.status])).toEqual([
      ['Barra de la Comisión', 800, 800, 0, 'OWN_BAR'],
      ['Churrería', 0, 0, 0, 'NOTHING'],
      ['Peña El Trago', 1800, 180, 1620, 'READY'],
    ]);
    expect(s.totals).toEqual({ soldCents: 2_600, organizerCents: 980, toPayCents: 1_620, transfers: 1, transfersCents: 1_620, missingIban: 0 });
    expect(s.wristbands).toEqual({ loadedCents: 10_000, refundedCents: 400, leftCents: 15_500 });
  });

  it('el fichero SEPA: el local paga a la Peña 16,20 € (la barra propia, fuera)', async () => {
    const { xml } = await inVenue(V, () => panel.sepa(ownerJwt(), PartySettlementQuerySchema.parse({})));
    expect(xml.match(/<NbOfTxs>1<\/NbOfTxs>/g)).toHaveLength(2);
    expect(xml.match(/<CtrlSum>16\.20<\/CtrlSum>/g)).toHaveLength(2);
    expect(xml).toContain(`<DbtrAcct><Id><IBAN>${VENUE_IBAN}</IBAN></Id></DbtrAcct>`);
    expect(xml).toContain(`<CdtrAcct><Id><IBAN>${STALL_IBAN}</IBAN></Id></CdtrAcct>`);
    expect(xml).toContain('<Ustrd>OxioParty Fiestas de San Juan Pena El Trago</Ustrd>');
    expect(xml).not.toContain('Barra de la Comision');
    const logged = await sys((tx) => tx.auditEvent.findMany({ where: { tenantId: V, action: 'party.settlement.sepa_exported' } }));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ actorId: owner, payload: expect.objectContaining({ transfers: 1, totalCents: 1_620, fromNight: null, toNight: null }) });
  });

  it('el fichero SEPA otra vez con las mismas noches: 409 ALREADY_EXPORTED (cuándo y quién) salvo again; otras noches, no', async () => {
    const whole = PartySettlementQuerySchema.parse({});
    const err = await inVenue(V, () => panel.sepa(ownerJwt(), whole)).catch((e: unknown) => e);
    const first = await sys((tx) => tx.auditEvent.findFirstOrThrow({ where: { tenantId: V, action: 'party.settlement.sepa_exported' } }));
    expect(err).toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'ALREADY_EXPORTED', exportedAt: first.occurredAt.toISOString(), exportedBy: `org-${r}` }),
    });
    expect(await sys((tx) => tx.auditEvent.count({ where: { tenantId: V, action: 'party.settlement.sepa_exported' } }))).toBe(1);
    // A propósito (el panel lo confirma): sale y queda en el registro como repetido.
    const again = await inVenue(V, () => panel.sepa(ownerJwt(), whole, new Date(), { again: true }));
    expect(again.xml).toContain('<CtrlSum>16.20</CtrlSum>');
    const last = await sys((tx) => tx.auditEvent.findFirstOrThrow({ where: { tenantId: V, action: 'party.settlement.sepa_exported' }, orderBy: { id: 'desc' } }));
    expect(last.payload).toMatchObject({ again: true, previousAt: first.occurredAt.toISOString() });
    // Otro rango de noches es otro fichero (aquí sin nada que pagar: 409 NO_TRANSFERS, no ALREADY_EXPORTED).
    await expect(inVenue(V, () => panel.sepa(ownerJwt(), PartySettlementQuerySchema.parse({ from: '2020-01-01', to: '2020-01-02' })))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'NO_TRANSFERS' }),
    });
    // Ni el de otro local cuenta.
    await expect(inVenue(OTHER, () => panel.sepa({ ...ownerJwt(), tenantId: OTHER }, whole))).rejects.not.toMatchObject({
      response: expect.objectContaining({ code: 'ALREADY_EXPORTED' }),
    });
  });

  it('cambiar la parte de la caseta cambia la liquidación (es la de ahora); unas noches sin ventas, a 0', async () => {
    await inVenue(V, () => stalls.update(ownerJwt(), A, { organizerBps: 2500 }));
    try {
      const s = await inVenue(V, () => panel.settlement(V, PartySettlementQuerySchema.parse({})));
      expect(s.rows.find((x) => x.stallId === A)).toMatchObject({ organizerCents: 450, toPayCents: 1350 });
    } finally {
      await inVenue(V, () => stalls.update(ownerJwt(), A, { organizerBps: 1000 }));
    }
    const past = await inVenue(V, () => panel.settlement(V, PartySettlementQuerySchema.parse({ from: '2020-01-01', to: '2020-01-02' })));
    expect(past.totals.soldCents).toBe(0);
  });

  it('la devolución ya hecha está en el cobro, y nada del otro local entra', async () => {
    const refunded = await sys((tx) => tx.refund.findFirstOrThrow({ where: { paymentId: cardSale } }));
    expect(refunded.status).toBe('SUCCEEDED');
    const other = await inVenue(OTHER, () => panel.live(OTHER, PartyLiveQuerySchema.parse({})));
    expect(other.sold.totalCents).toBe(9_999);
    expect(other.stalls.map((s) => s.name)).toEqual(['Sin caseta']);
  });
});
