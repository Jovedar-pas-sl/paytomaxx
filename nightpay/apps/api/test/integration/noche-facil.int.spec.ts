// Integración (Postgres real): «Noche fácil». NFC sin PIN hasta el máximo y
// el tope de la noche (con el saldo bloqueado: dos cobros a la vez no se saltan
// el tope), la noche de 08:00 a 08:00 de Madrid, el PIN que vuelve a contar,
// los saldos sumados; recargas pendientes de asignar (cobrar primero sin el
// NFC, Incidencias, asignar con el código); locales nuevos con el datáfono
// apagado; y lo que la migración no deja guardar. np_app y FORCE RLS.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { paymentMethodsOf } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { lastNightCutoff } from '../../src/common/time/madrid';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { SuperAdminVenuesService } from '../../src/modules/superadmin/venues.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';
import { PendingTopUpService } from '../../src/modules/wallets/wallet-pending-topup.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = { log: vi.fn(async (_e: { action: string }) => undefined) };
const metrics = {
  paymentsCreated: { inc: vi.fn() },
  paymentsTransitioned: { inc: vi.fn() },
  walletCreditSkipped: { inc: vi.fn() },
  duplicateCharges: { inc: vi.fn() },
};
const realtime = { emitPaymentUpdate: vi.fn(), emitPaymentCompleted: vi.fn() };
const queue = { add: vi.fn(async () => undefined) };
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  realtime as never,
  metrics as never,
  {} as never,
  {} as never,
);
const charges = new WalletChargesService(prisma as never, audit as never, { get: () => ({}) } as never, { isEnabled: async () => true, assertForUser: async () => undefined } as never);
const pending = new PendingTopUpService(prisma as never, audit as never, charges, { get: () => payments } as never);
const incidents = new IncidentsService(prisma as never, audit as never);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>, userId?: string, role?: string): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, userId, role, traceId: 't' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) =>
  inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let V: string;
let lola: string;
let pablo: string;
let rocio: string; // recepción: carga los saldos
let javi: string;
let n = 0;

const chica = () => ({ userId: lola, role: 'OPERATOR' as const, tenantId: V });
const camarero = () => ({ userId: pablo, role: 'WAITER' as const, tenantId: V });
const recepcion = () => ({ userId: rocio, role: 'WAITER' as const, tenantId: V });

function code6(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}

/** Saldo con PIN 4827 (elegido por el cliente) y su NFC dado con su número de serie. */
async function walletWithNfc(balanceCents: number): Promise<{ id: string; code: string; card: string; uid: string }> {
  n += 1;
  const code = code6();
  const card = randomBytes(16).toString('base64url');
  const uid = randomBytes(7).toString('hex').toUpperCase();
  const id = await sys(async (tx) => {
    const w = await tx.clientWallet.create({
      data: { tenantId: V, balanceCents, qrToken: `nf-${r}-${n}`, shortCode: code, walletGroup: `gnf-${r}` },
    });
    await tx.walletCard.create({ data: { token: card, uid, walletId: w.id, status: 'ISSUED', venueId: V } });
    return w.id;
  });
  await inVenue(undefined, () => charges.setPinFromPayer(id, '4827'));
  return { id, code, card, uid };
}

const qr = (amountCents: number) => inVenue(V, () => charges.createQrCharge(chica(), { amountCents }));
const payNfc = (requestId: string, w: { card: string; uid: string }) =>
  inVenue(V, () => charges.payQrChargeWithCard(chica(), requestId, { card: w.card, uid: w.uid }));
const payPin = (requestId: string, w: { card: string; uid: string }) =>
  inVenue(V, () => charges.payQrChargeWithPin(chica(), requestId, { card: w.card, uid: w.uid, pin: '4827' }));
const consumptions = (walletId: string) =>
  sys((tx) =>
    tx.walletConsumption.findMany({ where: { walletId }, orderBy: { createdAt: 'asc' }, select: { amountCents: true, authMethod: true } }),
  );
const walletRow = (id: string) => sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id } }));

beforeAll(async () => {
  await prisma.onModuleInit();
  await sys(async (tx) => {
    V = (await tx.venue.create({ data: { name: 'Sala Noche Fácil', slug: `nf-${r}`, walletGroup: `gnf-${r}` } })).id;
    await tx.terminal.create({ data: { tenantId: V, externalId: `TNF-${r}`, label: 'Barra', zone: 'BARRA' } });
    await tx.gatewayCredential.create({
      data: { tenantId: V, provider: 'REDSYS', encKey: Buffer.from('k'), encNonce: Buffer.from('n'), encTag: Buffer.from('t'), kekVersion: 1 },
    });
    lola = (
      await tx.user.create({
        data: { tenantId: V, email: `lola-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR', commissionBps: 5000, displayName: 'Lola' },
      })
    ).id;
    pablo = (await tx.user.create({ data: { tenantId: V, email: `pablo-${r}@x.es`, passwordHash: 'x', role: 'WAITER' } })).id;
    rocio = (
      await tx.user.create({
        data: { tenantId: V, email: `rocio-${r}@x.es`, passwordHash: 'x', role: 'WAITER', post: 'RECEPCION', displayName: 'Rocío' },
      })
    ).id;
    javi = (await tx.user.create({ data: { tenantId: V, email: `javi-${r}@x.es`, passwordHash: 'x', role: 'MANAGER' } })).id;
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('la migración (20261023200000)', () => {
  it('ajustes de la noche: solo un objeto JSON; cómo se autorizó: solo los cuatro valores', async () => {
    await expect(sys((tx) => tx.$executeRaw`UPDATE venues SET "nightSettings" = '[]'::jsonb WHERE id = ${V}::uuid`)).rejects.toThrow(
      /venues_night_settings_is_object/,
    );
    const w = await walletWithNfc(1_000);
    await expect(
      sys(
        (tx) => tx.$executeRaw`
          INSERT INTO wallet_consumptions ("tenantId", "walletId", "amountCents", "providedByUserId", category, "authMethod")
          VALUES (${V}::uuid, ${w.id}::uuid, 100, ${lola}::uuid, 'VENUE_BAR', 'magia')`,
      ),
    ).rejects.toThrow(/wallet_consumptions_auth_method/);
  });
});

describe('NFC sin PIN (Postgres real)', () => {
  it('15 €: sin PIN, como nfc_nopin; 40 €: PIN_REQUIRED y el mismo cobro con PIN (como pin); Face ID (passkey) y el encargado (staff), también marcados', async () => {
    const w = await walletWithNfc(20_000);
    const c1 = await qr(1_500);
    await expect(payNfc(c1.id, w)).resolves.toMatchObject({ status: 'ACCEPTED', newBalanceCents: 18_500 });
    const c2 = await qr(4_000);
    await expect(payNfc(c2.id, w)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PIN_REQUIRED', reason: 'over_max' }) });
    await expect(payPin(c2.id, w)).resolves.toMatchObject({ status: 'ACCEPTED', newBalanceCents: 14_500 });
    const c3 = await qr(1_000);
    await inVenue(undefined, () => charges.payQrCharge(c3.payToken, w.id));
    const c4 = await qr(500);
    await inVenue(V, () => charges.approveWithoutFaceId({ userId: javi, role: 'MANAGER', tenantId: V }, c4.id, w.id, '123456'));
    expect(await consumptions(w.id)).toEqual([
      { amountCents: 1_500, authMethod: 'nfc_nopin' },
      { amountCents: 4_000, authMethod: 'pin' },
      { amountCents: 1_000, authMethod: 'passkey' },
      { amountCents: 500, authMethod: 'staff' },
    ]);
  });

  it('dos cobros sin PIN a la vez que juntos pasan del tope de la noche: pasa uno; el otro pide el PIN; tras el PIN vuelve a contar', async () => {
    const w = await walletWithNfc(30_000);
    for (let i = 0; i < 4; i += 1) await payNfc((await qr(2_000)).id, w); // 80 € sin PIN
    const [a, b] = [await qr(1_500), await qr(1_500)];
    const out = await Promise.allSettled([payNfc(a.id, w), payNfc(b.id, w)]);
    expect(out.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = out.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ response: expect.objectContaining({ code: 'PIN_REQUIRED', reason: 'night_cap' }) });
    expect((await walletRow(w.id)).balanceCents).toBe(30_000 - 8_000 - 1_500);
    // El rechazado se paga con el PIN: lo gastado sin PIN vuelve a contar desde ahí.
    const left = out[0]!.status === 'rejected' ? a : b;
    await expect(payPin(left.id, w)).resolves.toMatchObject({ status: 'ACCEPTED' });
    expect((await walletRow(w.id)).noPinResetAt).not.toBeNull();
    await expect(payNfc((await qr(2_000)).id, w)).resolves.toMatchObject({ status: 'ACCEPTED' });
  });

  it('la noche de Madrid: lo de antes de las 08:00 no cuenta (otra noche); lo de después, sí', async () => {
    const cutoff = lastNightCutoff(new Date());
    const before = await walletWithNfc(20_000);
    const after = await walletWithNfc(20_000);
    await sys(async (tx) => {
      await tx.walletConsumption.create({
        data: {
          tenantId: V, walletId: before.id, amountCents: 9_900, providedByUserId: lola, category: 'VENUE_BAR',
          authMethod: 'nfc_nopin', createdAt: new Date(cutoff.getTime() - 1_000),
        },
      });
      await tx.walletConsumption.create({
        data: {
          tenantId: V, walletId: after.id, amountCents: 9_900, providedByUserId: lola, category: 'VENUE_BAR',
          authMethod: 'nfc_nopin', createdAt: new Date(cutoff.getTime() + 1_000),
        },
      });
    });
    await expect(payNfc((await qr(2_000)).id, before)).resolves.toMatchObject({ status: 'ACCEPTED' });
    await expect(payNfc((await qr(200)).id, after)).rejects.toMatchObject({ response: expect.objectContaining({ reason: 'night_cap' }) });
  });

  it('saldos sumados: lo gastado sin PIN en la recarga que se sumó cuenta en el saldo del cliente', async () => {
    const src = await walletWithNfc(20_000);
    for (let i = 0; i < 4; i += 1) await payNfc((await qr(2_000)).id, src); // 80 €
    await payNfc((await qr(1_000)).id, src); // 90 €
    const target = await sys((tx) =>
      tx.clientWallet.create({ data: { tenantId: V, balanceCents: 1_000, qrToken: `nf-t-${r}-${(n += 1)}`, shortCode: code6(), walletGroup: `gnf-${r}` } }),
    );
    await inVenue(undefined, () => charges.mergeInto(src.id, target.id));
    // Su NFC va con el dinero al saldo del cliente: 90 € ya gastados sin PIN esta noche.
    await expect(payNfc((await qr(1_500)).id, src)).rejects.toMatchObject({ response: expect.objectContaining({ reason: 'night_cap' }) });
    await expect(payNfc((await qr(1_000)).id, src)).resolves.toMatchObject({ status: 'ACCEPTED' });
    expect(await consumptions(target.id)).toEqual([{ amountCents: 1_000, authMethod: 'nfc_nopin' }]);
  });
});

describe('recargas pendientes de asignar (Postgres real)', () => {
  it('cobrar primero, pagarse, salir en Incidencias, asignarla con el código y desaparecer', async () => {
    const client = await walletWithNfc(1_000);
    // Las recargas se hacen en recepción: la chica y el camarero de barra, 403.
    for (const who of [chica(), camarero()]) {
      await expect(
        inVenue(V, () => pending.start(who, { amountCents: 5_000, idempotencyKey: `rec-no-${r}` }), who.userId, who.role),
      ).rejects.toMatchObject({ response: { code: 'TOP_UP_RECEPTION_ONLY', message: 'Las recargas se hacen en recepción.' } });
    }
    const created = await inVenue(V, () => pending.start(recepcion(), { amountCents: 5_000, idempotencyKey: `rec-pend-${r}` }), rocio, 'WAITER');
    const prov = created.walletId!;
    expect(await walletRow(prov)).toMatchObject({ pendingAssignById: rocio, balanceCents: 0, status: 'ACTIVE' });
    // La misma clave (doble toque): el mismo cobro.
    const again = await inVenue(V, () => pending.start(recepcion(), { amountCents: 5_000, idempotencyKey: `rec-pend-${r}` }), rocio, 'WAITER');
    expect(again.id).toBe(created.id);

    // Sin pagar aún: no se asigna ni sale en la lista.
    await expect(inVenue(V, () => pending.assign(recepcion(), prov, { code: client.code }))).rejects.toThrow(/pagada/);
    await expect(inVenue(V, () => pending.list(camarero()))).resolves.toEqual([]);

    // El cliente paga en su móvil.
    await inVenue(undefined, () => payments.transition(created.id, { type: 'AUTHORIZING' }));
    await sys(async (tx) => {
      await tx.payment.update({ where: { id: created.id }, data: { provider: 'REDSYS', providerTxId: `o-${r}` } });
      await tx.paymentAttempt.create({
        data: { paymentId: created.id, tenantId: V, provider: 'REDSYS', providerTxId: `o-${r}`, amountCents: 5_000, tipCents: 0 },
      });
    });
    await inVenue(undefined, () => payments.transition(created.id, { type: 'AUTHORIZED', provider: 'REDSYS', providerTxId: `o-${r}` }));
    expect(await walletRow(prov)).toMatchObject({ balanceCents: 5_000 });
    await expect(inVenue(V, () => pending.list(camarero()))).resolves.toEqual([
      expect.objectContaining({ walletId: prov, amountCents: 5_000, byName: 'Rocío' }),
    ]);

    // A los 10 min sin asignar, en Incidencias (y no como «saldo sin devolver»).
    const later = new Date(Date.now() + 11 * 60_000);
    const inbox = await inVenue(V, () => incidents.list(V, later));
    expect(inbox.filter((i) => i.refId === prov).map((i) => i.kind)).toEqual(['wallet_topup_unassigned']);

    // El camarero de barra no la asigna (403); recepción, con el código del cliente.
    await expect(inVenue(V, () => pending.assign(camarero(), prov, { code: client.code }))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TOP_UP_RECEPTION_ONLY' }),
    });
    await expect(inVenue(V, () => pending.assign(recepcion(), prov, { code: client.code }))).resolves.toMatchObject({
      walletId: client.id,
      amountCents: 5_000,
      balanceCents: 6_000,
    });
    expect(await walletRow(client.id)).toMatchObject({ balanceCents: 6_000 });
    expect(await walletRow(prov)).toMatchObject({ balanceCents: 0, status: 'DEPLETED', mergedIntoId: client.id, pendingAssignAt: null });
    const after = await inVenue(V, () => incidents.list(V, later));
    expect(after.some((i) => i.refId === prov)).toBe(false);
    await expect(inVenue(V, () => pending.assign(recepcion(), prov, { code: client.code }))).rejects.toThrow(/pendiente/);
  });
});

describe('locales nuevos', () => {
  it('el super-admin da de alta un local: el datáfono y «Las compañeras cobran desde su móvil», apagados; lo demás, como siempre', async () => {
    const venues = new SuperAdminVenuesService(
      prisma,
      { verify: async () => undefined } as never,
      { write: vi.fn(async () => undefined) } as never,
      { get: () => '7' } as never,
    );
    const created = await inVenue(undefined, () => venues.create({ id: lola, email: 'super@x.es' } as never, { name: `Nuevo ${r}`, slug: `nf-nuevo-${r}` }));
    const row = await sys((tx) =>
      tx.venue.findUniqueOrThrow({ where: { id: created.id }, select: { paymentMethods: true, operatorsChargeFromPhone: true } }),
    );
    expect(paymentMethodsOf(row.paymentMethods)).toMatchObject({ pos: false, card: true, wallet: true, nfc: true, cashTopUp: true });
    // Sus servicios los cobra el encargado (decisión del dueño, 25-nov-2026).
    expect(row.operatorsChargeFromPhone).toBe(false);
    expect(created.rules.operatorsChargeFromPhone).toBe(false);
  });
});
