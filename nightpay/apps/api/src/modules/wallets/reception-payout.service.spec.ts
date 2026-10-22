import { describe, expect, it, vi } from 'vitest';
import { ReceptionPayoutService } from './reception-payout.service';
import { ReceptionPayoutPasskeys } from './reception-payout-passkey';
import { renderPayoutConfirmPage } from './reception-payout-page';
import { PublicPayoutConfirmController } from './public-payout-confirm.controller';

const UID = '04A23B5C1D8011';
const CARD = 'FichaRecepcionPruebas123';
const actor = { userId: '00000000-0000-4000-8000-0000000000a1', role: 'WAITER' as const, tenantId: '00000000-0000-4000-8000-0000000000b1' };
const proof = { card: CARD, uid: UID, expectedAmountCents: 3_500, requestKey: 'salida-faceid-0001' };

function memoryRedis() {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => { store.set(k, v); return 'OK'; },
    pttl: async (k: string) => (store.has(k) ? 120_000 : -2),
  };
}

function setup(o: { passkey?: boolean; balance?: number; used?: boolean; owner?: string } = {}) {
  const wallet = { id: 'w-1', tenantId: actor.tenantId, walletGroup: null, status: 'ACTIVE', balanceCents: o.balance ?? 3_500, pinHash: 'x' };
  const card = { id: 'c-1', token: CARD, uid: UID, walletId: 'w-1', status: 'ISSUED', venueId: actor.tenantId };
  const venue = { id: actor.tenantId, name: 'Luna', walletGroup: null, refundApprovalThresholdCents: 10_000, paymentMethods: null, postRules: null,
    sections: null, staffPermissions: null, nightSettings: null };
  const tx = {
    venue: { findUnique: vi.fn(async () => venue) },
    user: { findFirst: vi.fn(async () => ({ post: 'RECEPCION' })) },
    walletCard: { findUnique: vi.fn(async () => card) },
    clientWallet: { findUnique: vi.fn(async () => wallet) },
    walletPayout: { findUnique: vi.fn(async () => (o.used ? { id: 'p-1' } : null)) },
    $queryRaw: vi.fn(async () => [{ inCents: 3_500n, inWindowCents: 3_500n, outCents: 0n, outWindowCents: 0n }]),
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)), acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const audit = { log: vi.fn(async () => undefined), logInTx: vi.fn() };
  const passkeys = {
    hasPasskey: vi.fn(async () => o.passkey ?? true),
    challenge: vi.fn(async (scope: string) => ({ challenge: 'c', scope })),
    verify: vi.fn(async () => o.owner ?? 'w-1'),
  };
  const requests = new ReceptionPayoutPasskeys(memoryRedis() as never);
  const config = { get: vi.fn(() => 'https://api.oxio.test/') };
  const svc = new ReceptionPayoutService(prisma as never, audit as never, {} as never, {} as never, passkeys as never, requests, config as never);
  return { svc, passkeys, audit, requests };
}

describe('salida con Face ID: el QR para el móvil del cliente', () => {
  it('con el NFC original y el importe de ahora: un enlace /w/salida/<token> que caduca', async () => {
    const { svc, audit } = setup();
    const out = await svc.requestPasskey(actor, 'w-1', proof);
    expect(out.url).toMatch(/^https:\/\/api\.oxio\.test\/w\/salida\/[A-Za-z0-9_-]{24}$/);
    expect(Date.parse(out.expiresAt)).toBeGreaterThan(Date.now());
    expect((await svc.requestPasskey(actor, 'w-1', proof)).url).toBe(out.url);
    expect(audit.log).toHaveBeenCalledTimes(1);
    await expect(svc.passkeyStatus(actor, 'w-1', proof.requestKey)).resolves.toEqual({ status: 'waiting' });
    await expect(svc.passkeyStatus({ ...actor, userId: 'otra' }, 'w-1', proof.requestKey)).resolves.toEqual({ status: 'expired' });
    await expect(svc.passkeyStatus(actor, 'w-1', 'otra-salida-01')).resolves.toEqual({ status: 'expired' });
  });

  it('sin Face ID, con otro importe o una salida ya hecha: no hay QR', async () => {
    await expect(setup({ passkey: false }).svc.requestPasskey(actor, 'w-1', proof)).rejects.toMatchObject({ response: { code: 'FACE_ID_NOT_SET' } });
    await expect(setup({ balance: 2_000 }).svc.requestPasskey(actor, 'w-1', proof)).rejects.toThrow(/cambiado/);
    await expect(setup({ used: true }).svc.requestPasskey(actor, 'w-1', proof)).rejects.toThrow(/ya se usó/);
    await expect(setup().svc.requestPasskey(actor, 'w-1', { ...proof, uid: '04000000000000' })).rejects.toThrow(/NFC/);
  });

  it('el cliente lo confirma con la llave de ESE saldo; la de otro saldo no vale', async () => {
    const { svc, passkeys } = setup();
    const token = (await svc.requestPasskey(actor, 'w-1', proof)).url.split('/').pop()!;
    await expect(svc.confirmView(token)).resolves.toEqual({ amountCents: 3_500, venueName: 'Luna', confirmed: false });
    await expect(svc.challenge(token, 'api.oxio.test')).resolves.toMatchObject({ scope: `payout:w-1:${proof.requestKey}` });
    await expect(svc.confirm(token, 'api.oxio.test', { id: 'cred' })).resolves.toEqual({ amountCents: 3_500 });
    expect(passkeys.verify).toHaveBeenCalledWith(`payout:w-1:${proof.requestKey}`, 'api.oxio.test', { id: 'cred' });
    await expect(svc.passkeyStatus(actor, 'w-1', proof.requestKey)).resolves.toEqual({ status: 'confirmed' });
    await expect(svc.challenge(token, undefined)).rejects.toMatchObject({ response: { code: 'PAYOUT_CONFIRMED' } });

    const other = setup({ owner: 'w-otro' });
    const t2 = (await other.svc.requestPasskey(actor, 'w-1', proof)).url.split('/').pop()!;
    await expect(other.svc.confirm(t2, undefined, {})).rejects.toMatchObject({ response: { code: 'FACE_ID_WRONG' } });
    await expect(other.svc.passkeyStatus(actor, 'w-1', proof.requestKey)).resolves.toEqual({ status: 'waiting' });
  });

  it('un QR que no existe o caducó: 404 y la página lo dice', async () => {
    const { svc } = setup();
    await expect(svc.challenge('AAAAAAAAAAAAAAAAAAAAAAAA', undefined)).rejects.toMatchObject({ status: 404 });
    await expect(svc.confirm('AAAAAAAAAAAAAAAAAAAAAAAA', undefined, {})).rejects.toMatchObject({ status: 404 });
    await expect(svc.confirmView('nope')).resolves.toBeNull();
  });
});

describe('la página del cliente', () => {
  it('dice el importe y el local, sin el código ni el id del saldo; en inglés también', () => {
    const html = renderPayoutConfirmPage('/w/salida/tok', 'es', { amountCents: 3_500, venueName: 'Luna <b>', confirmed: false });
    expect(html).toContain('35,00 €');
    expect(html).toContain('Luna &lt;b&gt;');
    expect(html).toContain('Confirmar con Face ID');
    expect(html).not.toMatch(/w-1|K7Q/);
    expect(renderPayoutConfirmPage('/w/salida/tok', 'en', { amountCents: 3_500, venueName: '', confirmed: true })).toContain('Confirmed');
    const gone = renderPayoutConfirmPage('/w/salida/tok', 'es', null);
    expect(gone).toContain('Este QR ya no vale');
    expect(gone).not.toContain('<script>');
  });

  it('el controlador sirve la página (404 si ya no vale) y pasa reto y firma al servicio', async () => {
    const payouts = { confirmView: vi.fn(async () => null), challenge: vi.fn(async () => ({ c: 1 })), confirm: vi.fn(async () => ({ amountCents: 1 })) };
    const ctrl = new PublicPayoutConfirmController(payouts as never);
    const res = { status: vi.fn().mockReturnThis(), header: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };
    await ctrl.page('tok', undefined, 'es', res as never);
    expect(res.status).toHaveBeenCalledWith(404);
    await expect(ctrl.challenge('tok', 'h')).resolves.toEqual({ c: 1 });
    await expect(ctrl.confirm('tok', { response: { id: 'x' } }, 'h')).resolves.toEqual({ amountCents: 1 });
    expect(payouts.confirm).toHaveBeenCalledWith('tok', 'h', { id: 'x' });
  });
});
