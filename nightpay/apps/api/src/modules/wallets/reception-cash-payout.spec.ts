import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WalletChargesService } from './wallet-charges.service';
import { hashPin } from './wallet-pin';

const PIN = '4827';
const PEPPER = 'recepcion-pruebas-0123456789abcdef0123456789';
const UID = '04A23B5C1D8011';
const CARD = 'FichaRecepcionPruebas123';
const actor = { userId: 'recepcion', role: 'WAITER' as const, tenantId: 'v-1' };
const input = { card: CARD, uid: UID, pin: PIN, expectedAmountCents: 5_000, requestKey: 'salida-prueba-0001' };
let pinHash = '';
const oldPepper = process.env.ENCRYPTION_KEK;
beforeAll(async () => { process.env.ENCRYPTION_KEK = PEPPER; pinHash = await hashPin(PIN, PEPPER); });
afterAll(() => { if (oldPepper === undefined) delete process.env.ENCRYPTION_KEK; else process.env.ENCRYPTION_KEK = oldPepper; });

function setup(o: { balance?: number; cash?: number; post?: string; card?: Record<string, unknown>; wallet?: Record<string, unknown> } = {}) {
  const wallet = { id: 'w-1', tenantId: 'v-1', walletGroup: 'grupo', shortCode: 'K7Q4M2', status: 'ACTIVE', balanceCents: o.balance ?? 5_000,
    pinHash, pinFails: 0, pinFailedAt: null, pinLockedAt: null, blockedAt: null, closeRequestedAt: null, ...o.wallet };
  const card = { id: 'c-1', token: CARD, uid: UID, walletId: 'w-1', status: 'ISSUED', venueId: 'v-1', ...o.card };
  const payouts: Array<Record<string, unknown>> = [];
  const tx = {
    venue: { findUnique: vi.fn(async () => ({ id: 'v-1', walletGroup: 'grupo', refundApprovalThresholdCents: 10_000, paymentMethods: null, postRules: null, sections: null, staffPermissions: null })) },
    user: { findFirst: vi.fn(async () => ({ post: o.post ?? 'RECEPCION' })) },
    walletCard: { findUnique: vi.fn(async () => ({ ...card })), findMany: vi.fn(async () => [{ ...card }]), updateMany: vi.fn(async () => { card.status = 'RETURNED'; card.walletId = null as never; return { count: 1 }; }) },
    walletCardEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
    clientWallet: { findUnique: vi.fn(async () => ({ ...wallet })), update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(wallet, data)),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { if (wallet.closeRequestedAt) return { count: 0 }; Object.assign(wallet, data); return { count: 1 }; }) },
    walletPayout: { findUnique: vi.fn(async ({ where }: { where: { tenantId_requestKey: { requestKey: string } } }) => payouts.find((p) => p.requestKey === where.tenantId_requestKey.requestKey) ?? null),
      findFirst: vi.fn(async () => null), create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `p-${payouts.length}`, ...data }; payouts.push(row); return row; }) },
    $queryRaw: vi.fn(async (q: TemplateStringsArray) => {
      const sql = q.join('?');
      if (sql.includes('wallet_cash_topups')) return [{ inCents: BigInt(o.cash ?? o.balance ?? 5_000), inWindowCents: BigInt(o.cash ?? o.balance ?? 5_000), outCents: BigInt(payouts.reduce((n, p) => n + Number(p.amountCents), 0)), outWindowCents: 0n }];
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
  const audit = { log: vi.fn(async () => undefined) };
  const totp = { assertForUser: vi.fn(async () => undefined), isEnabled: vi.fn(async () => true) };
  const svc = new WalletChargesService(prisma as never, audit as never, { get: () => ({}) } as never, totp as never);
  return { svc, wallet, card, payouts, tx, audit, totp };
}

describe('salida de recepción con NFC + PIN', () => {
  it('bloquea primero saldo y después NFC, como attachCard y payout administrativo', async () => {
    const { svc, tx } = setup();
    await svc.payoutAtReception(actor, 'w-1', input);
    const locks = tx.$queryRaw.mock.calls.map(([sql]) => sql.join('?')).filter((sql) => sql.includes('FOR UPDATE')).slice(-2);
    expect(locks[0]).toContain('FROM client_wallets');
    expect(locks[1]).toContain('FROM wallet_cards');
  });
  it('recupera el recibo que se confirma entre el precheck y la lectura del NFC ya devuelto', async () => {
    const { svc, tx, payouts } = setup();
    tx.walletCard.findUnique.mockImplementationOnce(async () => {
      payouts.push({ walletId: 'w-1', paidByUserId: actor.userId, amountCents: 5000, method: 'CASH', status: 'DONE', requestKey: input.requestKey, remainingBalanceCents: 0 });
      return { id: 'c-1', token: CARD, uid: UID, walletId: null, status: 'RETURNED', venueId: 'v-1' } as never;
    });
    await expect(svc.payoutAtReception(actor, 'w-1', input)).resolves.toEqual({ kind: 'done', refundedCents: 5000, remainingCents: 0 });
    expect(tx.walletPayout.create).not.toHaveBeenCalled();
  });
  it('una colisión concurrente de clave devuelve 409 y no filtra P2002', async () => {
    const { svc, tx } = setup();
    tx.walletPayout.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(svc.payoutAtReception(actor, 'w-1', input)).rejects.toMatchObject({ status: 409 });
  });
  it('recepción devuelve efectivo sin pedir el móvil del cliente y devuelve la ficha al stock', async () => {
    const { svc, wallet, payouts, card } = setup();
    await expect(svc.payoutAtReception(actor, 'w-1', input)).resolves.toMatchObject({ kind: 'done', refundedCents: 5_000, remainingCents: 0 });
    expect(wallet).toMatchObject({ balanceCents: 0, status: 'REFUNDED' });
    expect(payouts).toHaveLength(1);
    expect(card.status).toBe('RETURNED');
  });
  it('un PIN incorrecto se cuenta y no saca dinero', async () => {
    const { svc, wallet, payouts } = setup();
    await expect(svc.payoutAtReception(actor, 'w-1', { ...input, pin: '9999' })).rejects.toThrow(/PIN incorrecto/);
    expect(wallet.pinFails).toBe(1);
    expect(wallet.balanceCents).toBe(5_000);
    expect(payouts).toHaveLength(0);
  });
  it.each([{ uid: '04000000000000' }, { status: 'LOST' }, { walletId: 'otro' }])('rechaza un NFC que no autoriza ese saldo: %j', async (card) => {
    const { svc, payouts } = setup({ card });
    await expect(svc.payoutAtReception(actor, 'w-1', input)).rejects.toThrow();
    expect(payouts).toHaveLength(0);
  });
  it('barra no devuelve efectivo aunque conozca el NFC y el PIN', async () => {
    const { svc, payouts } = setup({ post: 'BARRA' });
    await expect(svc.payoutAtReception(actor, 'w-1', input)).rejects.toThrow();
    expect(payouts).toHaveLength(0);
  });
  it('no permite otro grupo de locales', async () => {
    const { svc, payouts } = setup({ wallet: { tenantId: 'v-2', walletGroup: 'otro' } });
    await expect(svc.payoutAtReception(actor, 'w-1', input)).rejects.toThrow();
    expect(payouts).toHaveLength(0);
  });
  it('si cambió el importe no devuelve una cantidad distinta de la confirmada', async () => {
    const { svc, wallet, payouts } = setup({ balance: 4_000 });
    await expect(svc.payoutAtReception(actor, 'w-1', input)).rejects.toThrow(/cambiado/);
    expect(wallet.balanceCents).toBe(4_000);
    expect(payouts).toHaveLength(0);
  });
  it('solo devuelve el efectivo de un saldo mixto', async () => {
    const { svc, wallet, card } = setup({ balance: 8_000, cash: 5_000 });
    await expect(svc.payoutAtReception(actor, 'w-1', input)).resolves.toMatchObject({ kind: 'done', refundedCents: 5_000, remainingCents: 3_000 });
    expect(wallet.balanceCents).toBe(3_000);
    expect(card.status).toBe('ISSUED');
  });
  it('por encima de 100 € queda solicitado al encargado y no sale efectivo', async () => {
    const { svc, wallet, payouts } = setup({ balance: 12_000 });
    await expect(svc.payoutAtReception(actor, 'w-1', { ...input, expectedAmountCents: 12_000 })).resolves.toMatchObject({ kind: 'manager', amountCents: 12_000 });
    expect(wallet.closeRequestedAt).toBeInstanceOf(Date);
    expect(wallet.balanceCents).toBe(12_000);
    expect(payouts).toHaveLength(0);
  });
  it('el encargado confirma importes altos con su propia 2FA', async () => {
    const { svc, payouts, totp } = setup({ balance: 12_000 });
    await expect(svc.payoutAtReception({ ...actor, role: 'MANAGER' }, 'w-1', { ...input, expectedAmountCents: 12_000 })).rejects.toThrow(/2FA|verificación/);
    expect(payouts).toHaveLength(0);
    await expect(svc.payoutAtReception({ ...actor, role: 'MANAGER' }, 'w-1', { ...input, expectedAmountCents: 12_000, totpCode: '123456' })).resolves.toMatchObject({ kind: 'done' });
    expect(totp.assertForUser).toHaveBeenCalledWith(actor.userId, '123456');
  });
  it('el límite 2FA de 100 € prevalece aunque el local configure 200 €', async () => {
    const { svc, payouts, tx } = setup({ balance: 15_000 });
    tx.venue.findUnique.mockImplementation(async () => ({ id: 'v-1', walletGroup: 'grupo', refundApprovalThresholdCents: 20_000, paymentMethods: null, postRules: null, sections: null, staffPermissions: null }));
    await expect(svc.payoutAtReception({ ...actor, role: 'MANAGER' }, 'w-1', { ...input, expectedAmountCents: 15_000 })).rejects.toThrow(/2FA|verificación/);
    expect(payouts).toHaveLength(0);
  });
  it('reintentar la misma petición no devuelve una nueva recarga', async () => {
    const { svc, wallet, payouts } = setup();
    const first = await svc.payoutAtReception(actor, 'w-1', input);
    Object.assign(wallet, { status: 'ACTIVE', balanceCents: 2_000 });
    await expect(svc.payoutAtReception(actor, 'w-1', input)).resolves.toEqual(first);
    expect(wallet.balanceCents).toBe(2_000);
    expect(payouts).toHaveLength(1);
  });
  it('dos peticiones simultáneas con la misma clave tienen un solo asiento', async () => {
    const { svc, payouts } = setup();
    const [a, b] = await Promise.all([svc.payoutAtReception(actor, 'w-1', input), svc.payoutAtReception(actor, 'w-1', input)]);
    expect(a).toEqual(b);
    expect(payouts).toHaveLength(1);
  });
  it('otra persona no puede reutilizar el recibo de recepción', async () => {
    const { svc, payouts } = setup();
    await svc.payoutAtReception(actor, 'w-1', input);
    await expect(svc.payoutAtReception({ ...actor, userId: 'otra-persona' }, 'w-1', input)).rejects.toThrow(/otra devolución/);
    expect(payouts).toHaveLength(1);
  });
  it('100 € exactos se devuelven con el NFC y PIN, por encima confirma el encargado', async () => {
    const { svc } = setup({ balance: 10_000 });
    await expect(svc.payoutAtReception(actor, 'w-1', { ...input, expectedAmountCents: 10_000 })).resolves.toMatchObject({ kind: 'done', refundedCents: 10_000 });
  });
});
