import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WalletChargesService } from './wallet-charges.service';
import { hashPin } from './wallet-pin';
import { receptionCashPayout, receptionPayoutPlan, type ReceptionCashInput } from './reception-cash-payout';
import type { PayoutPasskeyRequest } from './reception-payout-passkey';

const PIN = '4827';
const PEPPER = 'recepcion-pruebas-0123456789abcdef0123456789';
const UID = '04A23B5C1D8011';
const CARD = 'FichaRecepcionPruebas123';
const WAITER = { userId: '00000000-0000-4000-8000-0000000000a1', role: 'WAITER' as 'WAITER' | 'MANAGER' | 'OWNER', tenantId: '00000000-0000-4000-8000-0000000000b1' };
const MANAGER = { ...WAITER, role: 'MANAGER' as const };
const OWNER = { ...WAITER, role: 'OWNER' as const };
type Actor = typeof WAITER;
const input: ReceptionCashInput = { card: CARD, uid: UID, pin: PIN, expectedAmountCents: 5_000, requestKey: 'salida-prueba-0001' };
const device = { ip: '10.0.0.7', userAgent: 'Recepcion/1.0' };
let pinHash = '';
const oldPepper = process.env.ENCRYPTION_KEK;
beforeAll(async () => { process.env.ENCRYPTION_KEK = PEPPER; pinHash = await hashPin(PIN, PEPPER); });
afterAll(() => { if (oldPepper === undefined) delete process.env.ENCRYPTION_KEK; else process.env.ENCRYPTION_KEK = oldPepper; });

interface Options {
  balance?: number;
  cash?: number;
  post?: string;
  card?: Record<string, unknown>;
  wallet?: Record<string, unknown>;
  venue?: Record<string, unknown>;
  nightPaid?: number;
  capLoggedBefore?: boolean;
  passkey?: boolean;
  /** undefined: ninguna; {}: la de esta salida, confirmada; con campos: otra. */
  confirmation?: Partial<PayoutPasskeyRequest>;
}

function setup(o: Options = {}) {
  const wallet = { id: 'w-1', tenantId: WAITER.tenantId, walletGroup: 'grupo', shortCode: 'K7Q4M2', status: 'ACTIVE', balanceCents: o.balance ?? 5_000,
    pinHash, pinFails: 0, pinFailedAt: null, pinLockedAt: null, blockedAt: null, closeRequestedAt: null as Date | null, ...o.wallet };
  const card = { id: 'c-1', token: CARD, uid: UID, walletId: 'w-1', status: 'ISSUED', venueId: WAITER.tenantId, ...o.card };
  const venue = { id: WAITER.tenantId, name: 'Luna', walletGroup: 'grupo', refundApprovalThresholdCents: 10_000, paymentMethods: null, postRules: null,
    sections: null, staffPermissions: null, nightSettings: null, ...o.venue };
  const payouts: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const tx = {
    venue: { findUnique: vi.fn(async () => ({ ...venue })) },
    user: { findFirst: vi.fn(async () => ({ post: o.post ?? 'RECEPCION' })) },
    walletCard: { findUnique: vi.fn(async () => ({ ...card })), findMany: vi.fn(async () => [{ ...card }]),
      updateMany: vi.fn(async () => { card.status = 'RETURNED'; card.walletId = null as never; return { count: 1 }; }) },
    walletCardEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
    clientWallet: { findUnique: vi.fn(async () => ({ ...wallet })), update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(wallet, data)),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { if (wallet.closeRequestedAt) return { count: 0 }; Object.assign(wallet, data); return { count: 1 }; }) },
    walletPayout: { findUnique: vi.fn(async ({ where }: { where: { tenantId_requestKey: { requestKey: string } } }) => payouts.find((p) => p.requestKey === where.tenantId_requestKey.requestKey) ?? null),
      findFirst: vi.fn(async () => null), create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `p-${payouts.length}`, ...data }; payouts.push(row); return row; }) },
    auditEvent: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return data; }) },
    $queryRaw: vi.fn(async (q: TemplateStringsArray) => {
      const sql = q.join('?');
      if (sql.includes('pg_advisory_xact_lock')) return [{ locked: 1 }];
      if (sql.includes('FROM audit_events')) return o.capLoggedBefore || audits.some((a) => a.action === 'wallet.reception_payout_cap') ? [{ found: 1 }] : [];
      if (sql.includes('wallet_cash_topups')) {
        const out = payouts.reduce((n, p) => n + Number(p.amountCents), 0);
        return [{ inCents: BigInt(o.cash ?? o.balance ?? 5_000), inWindowCents: BigInt(o.cash ?? o.balance ?? 5_000), outCents: BigInt(out), outWindowCents: 0n }];
      }
      if (sql.includes('FROM wallet_payouts')) return [{ total: BigInt(o.nightPaid ?? 0) }];
      return sql.includes('FROM wallet_cards') ? [{ ...card }] : [{ ...wallet }];
    }),
  };
  let tail = Promise.resolve();
  const run = <T>(fn: (db: typeof tx) => Promise<T>): Promise<T> => {
    const result = tail.then(() => fn(tx));
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const prisma = { asSystem: vi.fn(run), acrossVenues: vi.fn(run) };
  const audit = {
    log: vi.fn(async () => undefined),
    logInTx: vi.fn(async (db: unknown, row: unknown) => { await (db as typeof tx).auditEvent.create({ data: row as Record<string, unknown> }); }),
  };
  const totp = { assertForUser: vi.fn(async () => undefined), isEnabled: vi.fn(async () => true) };
  const charges = new WalletChargesService(prisma as never, audit as never, { get: () => ({}) } as never, totp as never);
  const confirmation: PayoutPasskeyRequest | null = o.confirmation === undefined ? null : {
    walletId: 'w-1', tenantId: WAITER.tenantId, userId: WAITER.userId, requestKey: input.requestKey, amountCents: 5_000, venueName: 'Luna',
    confirmed: true, expiresAt: new Date(Date.now() + 60_000).toISOString(), ...o.confirmation,
  };
  const deps = (actor: Actor) => ({
    prisma: prisma as never,
    audit,
    totp,
    checkPin: (id: string, pin: string) => charges.checkPinForPayout(actor, id, pin),
    hasPasskey: vi.fn(async () => o.passkey ?? false),
    passkeyRequest: vi.fn(async () => confirmation),
  });
  const pay = (actor: Actor, body: Partial<ReceptionCashInput> = {}) => receptionCashPayout(deps(actor), actor, 'w-1', { ...input, ...body }, device);
  return { pay, deps, wallet, card, payouts, audits, tx, audit, totp };
}

describe('salida de recepción con NFC + PIN', () => {
  it('bloquea primero saldo y después NFC, como attachCard y payout administrativo', async () => {
    const { pay, tx } = setup();
    await pay(WAITER);
    const locks = tx.$queryRaw.mock.calls.map(([sql]) => sql.join('?')).filter((sql) => sql.includes('FOR UPDATE')).slice(-2);
    expect(locks[0]).toContain('FROM client_wallets');
    expect(locks[1]).toContain('FROM wallet_cards');
  });
  it('recupera el recibo que se confirma entre el precheck y la lectura del NFC ya devuelto', async () => {
    const { pay, tx, payouts } = setup();
    tx.walletCard.findUnique.mockImplementationOnce(async () => {
      payouts.push({ walletId: 'w-1', paidByUserId: WAITER.userId, amountCents: 5000, method: 'CASH', status: 'DONE', requestKey: input.requestKey, remainingBalanceCents: 0 });
      return { id: 'c-1', token: CARD, uid: UID, walletId: null, status: 'RETURNED', venueId: WAITER.tenantId } as never;
    });
    await expect(pay(WAITER)).resolves.toEqual({ kind: 'done', refundedCents: 5000, remainingCents: 0 });
    expect(tx.walletPayout.create).not.toHaveBeenCalled();
  });
  it('una colisión concurrente de clave devuelve 409 y no filtra P2002', async () => {
    const { pay, tx } = setup();
    tx.walletPayout.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(pay(WAITER)).rejects.toMatchObject({ status: 409 });
  });
  it('recepción devuelve efectivo, el NFC vuelve al stock y el registro va en la misma transacción', async () => {
    const { pay, wallet, payouts, card, audits, audit } = setup();
    await expect(pay(WAITER)).resolves.toMatchObject({ kind: 'done', refundedCents: 5_000, remainingCents: 0 });
    expect(wallet).toMatchObject({ balanceCents: 0, status: 'REFUNDED', closeRequestedAt: null });
    expect(payouts).toHaveLength(1);
    expect(card.status).toBe('RETURNED');
    expect(audit.log).not.toHaveBeenCalled();
    expect(audits).toEqual([expect.objectContaining({
      action: 'wallet.payout', actorId: WAITER.userId, targetId: 'w-1', ip: device.ip, userAgent: device.userAgent,
      payload: expect.objectContaining({ via: 'reception', cardId: 'c-1', requestKey: input.requestKey, payoutId: 'p-0', authorisedBy: ['nfc_pin'], twoFactor: false }),
    })]);
  });
  it('un PIN incorrecto se cuenta y no saca dinero', async () => {
    const { pay, wallet, payouts } = setup();
    await expect(pay(WAITER, { pin: '9999' })).rejects.toThrow(/PIN incorrecto/);
    expect(wallet.pinFails).toBe(1);
    expect(wallet.balanceCents).toBe(5_000);
    expect(payouts).toHaveLength(0);
  });
  it('sin PIN ni Face ID no hay salida', async () => {
    const { pay, payouts } = setup();
    await expect(pay(WAITER, { pin: undefined })).rejects.toThrow(/PIN/);
    expect(payouts).toHaveLength(0);
  });
  it.each([{ uid: '04000000000000' }, { status: 'LOST' }, { walletId: 'otro' }])('rechaza un NFC que no autoriza ese saldo: %j', async (card) => {
    const { pay, payouts } = setup({ card });
    await expect(pay(WAITER)).rejects.toThrow();
    expect(payouts).toHaveLength(0);
  });
  it('barra no devuelve efectivo aunque conozca el NFC y el PIN', async () => {
    const { pay, payouts } = setup({ post: 'BARRA' });
    await expect(pay(WAITER)).rejects.toMatchObject({ response: { code: 'CASH_PAYOUT_RECEPTION_ONLY' } });
    expect(payouts).toHaveLength(0);
  });
  it('a quien el dueño le quita «devolver en efectivo» no devuelve, aunque cobre recargas', async () => {
    const { pay, payouts } = setup({ venue: { staffPermissions: { people: { [WAITER.userId]: { cashPayout: false } } } } });
    await expect(pay(WAITER)).rejects.toMatchObject({ response: { code: 'STAFF_PERMISSION_DENIED', permission: 'cashPayout' } });
    expect(payouts).toHaveLength(0);
  });
  it('el encargado sin «Dar efectivo» no devuelve', async () => {
    const { pay, payouts } = setup({ venue: { staffPermissions: { roles: { MANAGER: { cash: false } } } } });
    await expect(pay(MANAGER)).rejects.toMatchObject({ response: { permission: 'cash' } });
    expect(payouts).toHaveLength(0);
  });
  it('no permite otro grupo de locales', async () => {
    const { pay, payouts } = setup({ wallet: { tenantId: 'v-2', walletGroup: 'otro' } });
    await expect(pay(WAITER)).rejects.toThrow();
    expect(payouts).toHaveLength(0);
  });
  it('si cambió el importe no devuelve una cantidad distinta de la confirmada', async () => {
    const { pay, wallet, payouts } = setup({ balance: 4_000 });
    await expect(pay(WAITER)).rejects.toThrow(/cambiado/);
    expect(wallet.balanceCents).toBe(4_000);
    expect(payouts).toHaveLength(0);
  });
  it('saldo mixto: el efectivo sale y el resto queda pedido «A la tarjeta» (con su registro)', async () => {
    const { pay, wallet, card, audits } = setup({ balance: 8_000, cash: 5_000 });
    await expect(pay(WAITER)).resolves.toMatchObject({ kind: 'done', refundedCents: 5_000, remainingCents: 3_000 });
    expect(wallet.balanceCents).toBe(3_000);
    expect(wallet.closeRequestedAt).toBeInstanceOf(Date);
    expect(card.status).toBe('ISSUED');
    expect(audits.map((a) => a.action)).toEqual(['wallet.payout', 'wallet.close_requested']);
    expect(audits[1]).toMatchObject({ payload: { reason: 'card_rest', remainingCents: 3_000, payoutId: 'p-0' } });
  });
  it('por encima de 100 € queda solicitado al encargado y no sale efectivo', async () => {
    const { pay, wallet, payouts, audits } = setup({ balance: 12_000 });
    await expect(pay(WAITER, { expectedAmountCents: 12_000 })).resolves.toMatchObject({ kind: 'manager', amountCents: 12_000, reasons: ['over_limit'] });
    expect(wallet.closeRequestedAt).toBeInstanceOf(Date);
    expect(wallet.balanceCents).toBe(12_000);
    expect(payouts).toHaveLength(0);
    expect(audits).toEqual([expect.objectContaining({ action: 'wallet.close_requested', payload: expect.objectContaining({ managerRequired: true, reasons: ['over_limit'] }) })]);
  });
  it('el encargado pone su 2FA antes del PIN: sin código no se gasta el PIN', async () => {
    const { pay, payouts, totp, wallet } = setup({ balance: 12_000 });
    await expect(pay(MANAGER, { expectedAmountCents: 12_000, pin: '9999' })).rejects.toMatchObject({ response: { code: 'TOTP_REQUIRED' } });
    expect(wallet.pinFails).toBe(0);
    expect(payouts).toHaveLength(0);
    await expect(pay(MANAGER, { expectedAmountCents: 12_000, totpCode: '123456' })).resolves.toMatchObject({ kind: 'done' });
    expect(totp.assertForUser).toHaveBeenCalledWith(MANAGER.userId, '123456', expect.stringMatching(/^cash-out:/));
  });
  it('con su 2FA queda «nfc_pin + manager_2fa» en el registro', async () => {
    const { pay, audits } = setup({ balance: 12_000 });
    await pay(MANAGER, { expectedAmountCents: 12_000, totpCode: '123456' });
    expect(audits[0]).toMatchObject({ action: 'wallet.payout', payload: { authorisedBy: ['nfc_pin', 'manager_2fa'], twoFactor: true } });
  });
  it('el límite 2FA de 100 € prevalece aunque el local configure 200 €', async () => {
    const { pay, payouts } = setup({ balance: 15_000, venue: { refundApprovalThresholdCents: 20_000 } });
    await expect(pay(MANAGER, { expectedAmountCents: 15_000 })).rejects.toThrow(/2FA|verificación/);
    expect(payouts).toHaveLength(0);
  });
  it('reintentar la misma petición no devuelve una nueva recarga', async () => {
    const { pay, wallet, payouts } = setup();
    const first = await pay(WAITER);
    Object.assign(wallet, { status: 'ACTIVE', balanceCents: 2_000 });
    await expect(pay(WAITER)).resolves.toEqual(first);
    expect(wallet.balanceCents).toBe(2_000);
    expect(payouts).toHaveLength(1);
  });
  it('dos peticiones simultáneas con la misma clave tienen un solo asiento', async () => {
    const { pay, payouts } = setup();
    const [a, b] = await Promise.all([pay(WAITER), pay(WAITER)]);
    expect(a).toEqual(b);
    expect(payouts).toHaveLength(1);
  });
  it('otra persona no puede reutilizar el recibo de recepción', async () => {
    const { pay, payouts } = setup();
    await pay(WAITER);
    await expect(pay({ ...WAITER, userId: '00000000-0000-4000-8000-0000000000a2' })).rejects.toThrow(/otra devolución/);
    expect(payouts).toHaveLength(1);
  });
  it('100,00 € justos los devuelve recepción; 100,01 €, el encargado', async () => {
    await expect(setup({ balance: 10_000 }).pay(WAITER, { expectedAmountCents: 10_000 })).resolves.toMatchObject({ kind: 'done', refundedCents: 10_000 });
    await expect(setup({ balance: 10_001 }).pay(WAITER, { expectedAmountCents: 10_001 })).resolves.toMatchObject({ kind: 'manager' });
  });
});

describe('tope de la noche de cada recepcionista', () => {
  it('al pasarlo, pendiente del encargado y a Incidencias una vez por noche', async () => {
    const { pay, audits, payouts } = setup({ nightPaid: 26_000 });
    await expect(pay(WAITER)).resolves.toMatchObject({ kind: 'manager', reasons: ['night_cap'] });
    expect(payouts).toHaveLength(0);
    expect(audits.map((a) => a.action)).toEqual(['wallet.reception_payout_cap', 'wallet.close_requested']);
    expect(audits[0]).toMatchObject({ actorId: WAITER.userId, payload: { amountCents: 5_000, nightPaidCents: 26_000, nightCapCents: 30_000 } });
    const again = setup({ nightPaid: 26_000, capLoggedBefore: true });
    await again.pay(WAITER);
    expect(again.audits.map((a) => a.action)).toEqual(['wallet.close_requested']);
  });
  it('justo en el tope, aún sale', async () => {
    await expect(setup({ nightPaid: 25_000 }).pay(WAITER)).resolves.toMatchObject({ kind: 'done' });
  });
  it('el tope lo pone el dueño en Ajustes → Noche (0 = siempre el encargado)', async () => {
    const s = setup({ venue: { nightSettings: { receptionPayoutNightCapCents: 0 } } });
    await expect(s.pay(WAITER)).resolves.toMatchObject({ kind: 'manager', reasons: ['night_cap'] });
  });
  it('el encargado pasado el tope pone su 2FA; el dueño no tiene tope', async () => {
    const m = setup({ nightPaid: 29_000 });
    await expect(m.pay(MANAGER)).rejects.toMatchObject({ response: { code: 'TOTP_REQUIRED' } });
    await expect(m.pay(MANAGER, { totpCode: '123456' })).resolves.toMatchObject({ kind: 'done' });
    expect(m.audits.map((a) => a.action)).toEqual(['wallet.reception_payout_cap', 'wallet.payout']);
    await expect(setup({ nightPaid: 99_000 }).pay(OWNER)).resolves.toMatchObject({ kind: 'done' });
  });
});

describe('saldo con Face ID: lo confirma el cliente en su móvil', () => {
  it('con NFC + PIN solo, no: 409 antes de tocar el PIN', async () => {
    const { pay, payouts, wallet } = setup({ passkey: true });
    await expect(pay(WAITER, { pin: '9999' })).rejects.toMatchObject({ response: { code: 'PAYOUT_PASSKEY_REQUIRED' } });
    expect(wallet.pinFails).toBe(0);
    expect(payouts).toHaveLength(0);
  });
  it('confirmado en su móvil: sale sin PIN y queda «passkey»', async () => {
    const { pay, audits } = setup({ passkey: true, confirmation: {} });
    await expect(pay(WAITER, { pin: undefined })).resolves.toMatchObject({ kind: 'done', refundedCents: 5_000 });
    expect(audits[0]).toMatchObject({ payload: { authorisedBy: ['passkey'] } });
  });
  it.each([{ walletId: 'otro' }, { userId: '00000000-0000-4000-8000-0000000000a9' }, { amountCents: 4_000 }, { confirmed: false }])(
    'una confirmación de otra salida no vale: %j',
    async (confirmation) => {
      const { pay, payouts } = setup({ passkey: true, confirmation });
      await expect(pay(WAITER, { pin: undefined })).rejects.toMatchObject({ response: { code: 'PAYOUT_PASSKEY_REQUIRED' } });
      expect(payouts).toHaveLength(0);
    },
  );
  it('sin su móvil, el encargado con su 2FA y el PIN del cliente; el dueño, con el PIN', async () => {
    const m = setup({ passkey: true });
    await expect(m.pay(MANAGER)).rejects.toMatchObject({ response: { code: 'TOTP_REQUIRED' } });
    await expect(m.pay(MANAGER, { totpCode: '123456' })).resolves.toMatchObject({ kind: 'done' });
    expect(m.audits[0]).toMatchObject({ payload: { authorisedBy: ['nfc_pin', 'manager_2fa'] } });
    await expect(setup({ passkey: true }).pay(OWNER)).resolves.toMatchObject({ kind: 'done' });
  });
  it('confirmado y de más de 100 €: pendiente del encargado (sin PIN)', async () => {
    const { pay } = setup({ passkey: true, balance: 12_000, confirmation: { amountCents: 12_000 } });
    await expect(pay(WAITER, { pin: undefined, expectedAmountCents: 12_000 })).resolves.toMatchObject({ kind: 'manager', reasons: ['over_limit'] });
  });
});

describe('plan de la salida (antes del PIN)', () => {
  it('dice qué hace falta: nada, el encargado o su Face ID', async () => {
    const plan = (o: Options, actor: Actor = WAITER) => { const s = setup(o); return receptionPayoutPlan(s.deps(actor), actor, 'w-1'); };
    await expect(plan({})).resolves.toEqual({ amountCents: 5_000, needs: 'none', reasons: [], passkey: false, nightPaidCents: 0, nightCapCents: 30_000 });
    await expect(plan({ balance: 12_000 })).resolves.toMatchObject({ amountCents: 12_000, needs: 'manager_pending', reasons: ['over_limit'] });
    await expect(plan({ balance: 12_000 }, MANAGER)).resolves.toMatchObject({ needs: 'manager_2fa' });
    await expect(plan({ nightPaid: 28_000 })).resolves.toMatchObject({ needs: 'manager_pending', reasons: ['night_cap'], nightPaidCents: 28_000 });
    await expect(plan({ passkey: true })).resolves.toMatchObject({ needs: 'none', passkey: true });
    await expect(plan({ balance: 8_000, cash: 3_000 })).resolves.toMatchObject({ amountCents: 3_000 });
    await expect(plan({ post: 'BARRA' })).rejects.toMatchObject({ status: 403 });
  });
});
