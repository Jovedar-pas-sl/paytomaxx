import { describe, expect, it, vi } from 'vitest';
import { ACTIVATION_LINK_UNAVAILABLE_CODE, walletActivationLinkPath } from '@nightpay/contracts';
import { WalletActivationLinkService, lastTopUpHere } from './wallet-activation-link.service';

const NOW = new Date('2026-10-27T01:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

interface Options {
  wallet?: Record<string, unknown> | null;
  role?: string;
  post?: string | null;
  passkey?: boolean;
  cashAt?: Date | null;
  cardAt?: Date | null;
  merged?: Array<{ id: string }>;
  venueGroup?: string | null;
  apiUrl?: string | undefined;
}

function make(o: Options = {}) {
  const wallet = o.wallet === null ? null : {
    id: 'w1', tenantId: 'venue-1', walletGroup: null, qrToken: 'privateWalletToken_0123', status: 'ACTIVE',
    blockedAt: null, mergedIntoId: null, pendingAssignAt: null, ...o.wallet,
  };
  const tx = {
    user: { findFirst: vi.fn(async () => ({ post: o.post === undefined ? 'RECEPCION' : o.post })) },
    venue: { findUnique: vi.fn(async () => ({ postRules: null, sections: null, walletGroup: o.venueGroup ?? null })) },
    clientWallet: { findUnique: vi.fn(async () => wallet), findMany: vi.fn(async () => o.merged ?? []) },
    walletCashTopUp: { findFirst: vi.fn(async () => (o.cashAt ? { createdAt: o.cashAt } : null)) },
    payment: { findFirst: vi.fn(async () => (o.cardAt ? { authorizedAt: o.cardAt } : null)) },
  };
  const prisma = { asSystem: (fn: (t: unknown) => unknown) => fn(tx), acrossVenues: (fn: (t: unknown) => unknown) => fn(tx) };
  const audit = { log: vi.fn(async () => undefined) };
  const passkeys = { hasPasskey: vi.fn(async () => o.passkey ?? false) };
  const config = { get: () => ('apiUrl' in o ? o.apiUrl : 'https://api.paytomaxx.com/') };
  const service = new WalletActivationLinkService(prisma as never, audit as never, passkeys as never, config as never);
  const actor = { userId: 'rx-1', role: o.role ?? 'WAITER', tenantId: 'venue-1' };
  return { service, tx, audit, passkeys, actor };
}

describe('QR de activación del saldo (recepción)', () => {
  it('recepción, justo tras recargar en efectivo: el enlace privado y hasta cuándo enseñarlo, registrado sin el enlace', async () => {
    const { service, audit, actor, tx } = make({ cashAt: minutesAgo(2) });
    const link = await service.link(actor, 'w1', NOW);
    expect(link).toEqual({ url: 'https://api.paytomaxx.com/w/privateWalletToken_0123', expiresAt: '2026-10-27T01:13:00.000Z' });
    expect(audit.log).toHaveBeenCalledWith({
      action: 'wallet.activation_link', tenantId: 'venue-1', actorId: 'rx-1', targetType: 'ClientWallet', targetId: 'w1',
      payload: { topUpAt: minutesAgo(2).toISOString(), expiresAt: '2026-10-27T01:13:00.000Z' },
    });
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('privateWalletToken');
    // Solo recargas de ESTE local, en la ventana, en efectivo sin anular o con tarjeta aprobada.
    // Las de número impreso no cuentan (no prueban que la ficha estuviera delante).
    expect(tx.walletCashTopUp.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        tenantId: 'venue-1', walletId: { in: ['w1'] }, amountCents: { gt: 0 }, voidedBy: { is: null }, createdAt: { gte: minutesAgo(15) },
        OR: [{ intentFingerprint: null }, { NOT: { intentFingerprint: { startsWith: 'printed:' } } }],
      },
    }));
    expect(tx.payment.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 'venue-1', walletId: { in: ['w1'] }, status: { in: ['AUTHORIZED', 'PARTIALLY_REFUNDED'] }, authorizedAt: { gte: minutesAgo(15) } },
    }));
  });

  it('la ventana cuenta desde la recarga más reciente (tarjeta o la sumada de una recarga pendiente)', async () => {
    const { service, actor, tx } = make({ cashAt: minutesAgo(14), cardAt: minutesAgo(1), merged: [{ id: 'provisional' }] });
    await expect(service.link(actor, 'w1', NOW)).resolves.toMatchObject({ expiresAt: '2026-10-27T01:14:00.000Z' });
    expect(tx.payment.findFirst.mock.calls[0]![0].where.walletId).toEqual({ in: ['w1', 'provisional'] });
  });

  it.each([['MANAGER', null], ['OWNER', null], ['WAITER', 'RECEPCION']])('%s (%s) puede', async (role, post) => {
    const { service, actor } = make({ role, post, cashAt: minutesAgo(1) });
    await expect(service.link(actor, 'w1', NOW)).resolves.toMatchObject({ url: expect.stringContaining('/w/') });
  });

  it.each([['WAITER', 'BARRA'], ['WAITER', null], ['OPERATOR', null]])('%s (%s): 403 como cualquier recarga, sin mirar el saldo', async (role, post) => {
    const { service, actor, tx, audit } = make({ role, post, cashAt: minutesAgo(1) });
    await expect(service.link(actor, 'w1', NOW)).rejects.toMatchObject({ status: 403, response: { code: 'TOP_UP_RECEPTION_ONLY' } });
    expect(tx.clientWallet.findUnique).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('con Face ID ya activado: 404 FACE_ID_SET (el cliente ya ve su saldo con su NFC)', async () => {
    const { service, actor, audit } = make({ passkey: true, cashAt: minutesAgo(1) });
    await expect(service.link(actor, 'w1', NOW)).rejects.toMatchObject({ status: 404, response: { code: ACTIVATION_LINK_UNAVAILABLE_CODE, reason: 'FACE_ID_SET' } });
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('pasados los 15 minutos, o sin recarga de este local: 404 NO_RECENT_TOP_UP', async () => {
    const { service, actor, audit } = make({ cashAt: null, cardAt: null });
    await expect(service.link(actor, 'w1', NOW)).rejects.toMatchObject({ status: 404, response: { reason: 'NO_RECENT_TOP_UP' } });
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each([
    ['no existe', null],
    ['bloqueado', { blockedAt: new Date() }],
    ['cerrado', { status: 'REFUNDED' }],
    ['gastado', { status: 'DEPLETED' }],
    ['sumado a otro', { mergedIntoId: 'w2' }],
    ['recarga pendiente de asignar', { pendingAssignAt: new Date() }],
    ['de otro grupo de locales', { tenantId: 'venue-9', walletGroup: 'otro' }],
  ])('saldo %s: 404 NOT_FOUND', async (_name, wallet) => {
    const { service, actor, passkeys } = make({ wallet: wallet as Record<string, unknown> | null, cashAt: minutesAgo(1), venueGroup: 'grupo' });
    await expect(service.link(actor, 'w1', NOW)).rejects.toMatchObject({ status: 404, response: { reason: 'NOT_FOUND' } });
    expect(passkeys.hasPasskey).not.toHaveBeenCalled();
  });

  it('un saldo del mismo grupo de locales sí (si lo recargó este local)', async () => {
    const { service, actor } = make({ wallet: { tenantId: 'venue-2', walletGroup: 'grupo' }, venueGroup: 'grupo', cashAt: minutesAgo(1) });
    await expect(service.link(actor, 'w1', NOW)).resolves.toBeDefined();
  });

  it('sin NEXT_PUBLIC_API_URL (en local), el API en su puerto; un valor roto, también', async () => {
    for (const apiUrl of [undefined, '', 'no es una url']) {
      const { service, actor } = make({ cashAt: minutesAgo(1), apiUrl });
      await expect(service.link(actor, 'w1', NOW)).resolves.toMatchObject({ url: 'http://localhost:4100/w/privateWalletToken_0123' });
    }
  });

  it('lastTopUpHere: null sin recargas; la más reciente de las dos', async () => {
    const tx = (cash: Date | null, card: Date | null) => ({
      walletCashTopUp: { findFirst: async () => (cash ? { createdAt: cash } : null) },
      payment: { findFirst: async () => (card ? { authorizedAt: card } : null) },
    });
    expect(await lastTopUpHere(tx(null, null) as never, 'v', ['w'], NOW)).toBeNull();
    expect(await lastTopUpHere(tx(minutesAgo(3), null) as never, 'v', ['w'], NOW)).toEqual(minutesAgo(3));
    expect(await lastTopUpHere(tx(minutesAgo(9), minutesAgo(4)) as never, 'v', ['w'], NOW)).toEqual(minutesAgo(4));
  });

  it('la ruta del contrato', () => {
    expect(walletActivationLinkPath('3f0c1d2e-0000-4000-8000-000000000001')).toBe('/v1/reception/wallets/3f0c1d2e-0000-4000-8000-000000000001/activation-link');
  });
});
