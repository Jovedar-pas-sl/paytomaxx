import 'reflect-metadata';
import { IP_RATE_LIMIT_META } from '../../common/guards/ip-rate-limit.guard';
import { CARD_PIN_VIEW_LIMIT, PublicWalletCardController } from './public-wallet-card.controller';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { WalletCardViewService } from './wallet-card-view.service';
const token = 'cardToken0123456789';
const wallet = { id: 'w1', qrToken: 'private-wallet-token', status: 'ACTIVE', blockedAt: null, shortCode: 'K7Q4M2' };
const card = { id: 'c1', status: 'ISSUED', walletId: wallet.id, wallet };
function make() {
  const findUnique = vi.fn().mockResolvedValue(card);
  const prisma = { acrossVenues: (fn: (tx: unknown) => unknown) => fn({ walletCard: { findUnique } }) };
  const keys = { hasPasskey: vi.fn().mockResolvedValue(true), challenge: vi.fn().mockResolvedValue({ challenge: 'random' }), verify: vi.fn().mockResolvedValue('w1') };
  return { service: new WalletCardViewService(prisma as never, keys as never, {} as never, {} as never, { get: () => "" } as never), findUnique, keys };
}
describe('consulta de ficha con llave del cliente', () => {
  it('ata el reto a la asignación actual y solo devuelve el enlace al dueño verificado', async () => {
    const { service, keys } = make();
    await expect(service.challenge(token, 'api.example')).resolves.toEqual({ challenge: 'random' });
    expect(keys.challenge).toHaveBeenCalledWith('card-view:c1:w1', 'api.example');
    await expect(service.unlock(token, 'api.example', { id: 'key' })).resolves.toEqual({ id: 'w1', qrToken: wallet.qrToken });
    expect(keys.verify).toHaveBeenCalledWith('card-view:c1:w1', 'api.example', { id: 'key' });
  });
  it('no permite activar una llave con solo acercar la ficha ni pasar sin autenticación', async () => {
    const { service, keys } = make();
    keys.hasPasskey.mockResolvedValue(false);
    await expect(service.challenge(token, 'api.example')).rejects.toMatchObject({ response: { code: 'FACE_ID_NOT_SET' } });
    expect(keys.challenge).not.toHaveBeenCalled();
    keys.verify.mockRejectedValue(new ForbiddenException());
    await expect(service.unlock(token, 'api.example', undefined)).rejects.toThrow(ForbiddenException);
  });
  it('rechaza una llave de otro cliente', async () => {
    const { service, keys } = make();
    keys.verify.mockResolvedValue('w2');
    await expect(service.unlock(token, 'api.example', {})).rejects.toThrow(ForbiddenException);
  });
  it.each(['STOCK', 'RETURNED', 'LOST', 'BLOCKED'])('no consulta una ficha %s', async (status) => {
    const { service, findUnique, keys } = make();
    findUnique.mockResolvedValue({ ...card, status });
    await expect(service.challenge(token, 'api.example')).rejects.toMatchObject({ status: 404 });
    await expect(service.unlock(token, 'api.example', {})).rejects.toMatchObject({ status: 404 });
    expect(keys.verify).not.toHaveBeenCalled();
  });
  it('no consulta saldos bloqueados, cerrados, sin titular o tokens inválidos', async () => {
    const { service, findUnique } = make();
    for (const value of [null, { ...card, wallet: null }, { ...card, wallet: { ...wallet, blockedAt: new Date() } }, { ...card, wallet: { ...wallet, status: 'CLOSED' } }]) {
      findUnique.mockResolvedValue(value);
      await expect(service.challenge(token, undefined)).rejects.toMatchObject({ status: 404 });
    }
    findUnique.mockClear();
    await expect(service.challenge('../invalid', undefined)).rejects.toMatchObject({ status: 404 });
    expect(findUnique).not.toHaveBeenCalled();
  });
  it('la ficha reasignada o bloqueada durante la confirmación no abre ningún saldo', async () => {
    for (const changed of [{ ...card, walletId: 'w2', wallet: { ...wallet, id: 'w2' } }, { ...card, status: 'BLOCKED' }]) {
      const { service, findUnique } = make();
      findUnique.mockResolvedValueOnce(card).mockResolvedValueOnce(changed);
      await expect(service.unlock(token, 'api.example', {})).rejects.toBeDefined();
    }
  });
  it('permite consultar cero sin volver a habilitar una ficha devuelta', async () => {
    const { service, findUnique } = make();
    findUnique.mockResolvedValue({ ...card, wallet: { ...wallet, status: 'DEPLETED' } });
    await expect(service.unlock(token, undefined, {})).resolves.toMatchObject({ id: 'w1' });
  });
  it('no entrega el enlace nuevo a una verificación iniciada con la llave anterior', async () => {
    const { service, findUnique } = make();
    findUnique.mockResolvedValueOnce(card).mockResolvedValueOnce({ ...card, wallet: { ...wallet, qrToken: 'regenerated-private-token' } });
    await expect(service.unlock(token, 'api.example', {})).rejects.toThrow(ForbiddenException);
  });
  it('pantalla de la ficha: con passkey, desbloquear; sin ella, cómo activarla; con el código tapado y sin el enlace', async () => {
    const { service, keys, findUnique } = make();
    await expect(service.pageView(token)).resolves.toMatchObject({ kind: 'locked', codeHint: 'K7Q-•••' });
    keys.hasPasskey.mockResolvedValue(false);
    await expect(service.pageView(token)).resolves.toMatchObject({ kind: 'setup', codeHint: 'K7Q-•••' });
    expect(JSON.stringify(await service.pageView(token))).not.toContain(wallet.qrToken);
    // Un saldo antiguo sin código: sin código tapado (nada de «-•••»).
    findUnique.mockResolvedValue({ ...card, wallet: { ...wallet, shortCode: null } });
    await expect(service.pageView(token)).resolves.toMatchObject({ kind: 'setup', codeHint: null });
  });
  it('pantalla de la ficha: bloqueada lo dice; devuelta, en stock, sin saldo vivo o con un token raro, no activa', async () => {
    const { service, findUnique, keys } = make();
    findUnique.mockResolvedValue({ ...card, status: 'BLOCKED' });
    await expect(service.pageView(token)).resolves.toEqual({ kind: 'blocked' });
    for (const value of [null, { ...card, status: 'RETURNED', walletId: null, wallet: null }, { ...card, status: 'LOST' }, { ...card, wallet: { ...wallet, blockedAt: new Date() } }, { ...card, wallet: { ...wallet, status: 'REFUNDED' } }]) {
      findUnique.mockResolvedValue(value);
      await expect(service.pageView(token)).resolves.toEqual({ kind: 'unavailable' });
    }
    findUnique.mockClear();
    await expect(service.pageView('../x')).resolves.toEqual({ kind: 'unavailable' });
    expect(findUnique).not.toHaveBeenCalled();
    expect(keys.hasPasskey).not.toHaveBeenCalled();
  });
});

describe('«Ver mi saldo con mi PIN» desde la ficha (B7)', () => {
  const NOW = new Date('2026-11-10T01:00:00Z');
  function withPin() {
    const prisma = {
      acrossVenues: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({
          walletCard: {
            findUnique: vi.fn(async () => ({
              id: 'c-1',
              status: 'ISSUED',
              walletId: 'w-1',
              wallet: { id: 'w-1', tenantId: 't-1', qrToken: 'secreto-del-saldo', status: 'ACTIVE', blockedAt: null, shortCode: 'K7Q4M2', pinHash: 'h' },
            })),
          },
          clientWallet: { findUnique: vi.fn(async () => ({ balanceCents: 3_540, status: 'ACTIVE' })) },
        }),
      ),
    };
    let right = '2468';
    const charges = { pinForCardView: vi.fn(async (_w: string, pin: string) => (pin === right ? 'ok' : 'wrong')) };
    const store = new Map<string, number>();
    const redis = {
      incr: vi.fn(async (k: string) => {
        store.set(k, (store.get(k) ?? 0) + 1);
        return store.get(k)!;
      }),
      expire: vi.fn(async () => 1),
      del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
    };
    const service = new WalletCardViewService(prisma as never, {} as never, {} as never, charges as never, { get: () => 'secreto-de-pruebas' } as never, redis as never);
    return { service, charges, redis, setRight: (pin: string) => (right = pin) };
  }
  const TOKEN = 'q3VbX9kLmN2pR7sT4wYz1A';

  it('con su PIN, el saldo durante 10 minutos; nada para pagar ni su enlace', async () => {
    const { service, charges } = withPin();
    const view = await service.viewWithPin(TOKEN, '2468', NOW);
    expect(charges.pinForCardView).toHaveBeenCalledWith('w-1', '2468');
    expect(view.balanceCents).toBe(3_540);
    expect(view.expiresAt).toBe(new Date(NOW.getTime() + 10 * 60_000).toISOString());
    expect(JSON.stringify(view)).not.toContain('secreto-del-saldo');
    // «Actualizar» con su vista, dentro de los 10 min; pasados, o tocada, no.
    await expect(service.viewAgain(TOKEN, view.viewToken, new Date(NOW.getTime() + 60_000))).resolves.toMatchObject({ balanceCents: 3_540 });
    await expect(service.viewAgain(TOKEN, view.viewToken, new Date(NOW.getTime() + 11 * 60_000))).rejects.toMatchObject({ status: 403 });
    const [exp, sig] = view.viewToken.split('.');
    await expect(service.viewAgain(TOKEN, `${Number(exp) + 60_000}.${sig}`, NOW)).rejects.toMatchObject({ status: 403 });
  });

  it('el PIN con su forma; sin PIN, que no lo tiene', async () => {
    const { service, charges } = withPin();
    await expect(service.viewWithPin(TOKEN, '12a4', NOW)).rejects.toMatchObject({ status: 400 });
    expect(charges.pinForCardView).not.toHaveBeenCalled();
  });

  it('su propio contador: 5 fallos cierran SOLO esta vista 24 h (ni con el PIN bueno, que ya no se mira); el PIN de pagar no se toca', async () => {
    const { service, redis, charges } = withPin();
    for (let i = 4; i >= 1; i -= 1) {
      await expect(service.viewWithPin(TOKEN, '1111', NOW)).rejects.toMatchObject({
        status: 422,
        response: expect.objectContaining({ code: 'PIN_WRONG', message: `PIN incorrecto. ${i === 1 ? 'Queda 1 intento' : `Quedan ${i} intentos`}` }),
      });
    }
    await expect(service.viewWithPin(TOKEN, '1111', NOW)).rejects.toMatchObject({
      status: 429,
      response: expect.objectContaining({ code: 'CARD_VIEW_LOCKED', message: expect.stringContaining('dentro de 24 horas') }),
    });
    await expect(service.viewWithPin(TOKEN, '2468', NOW)).rejects.toMatchObject({ status: 429, response: expect.objectContaining({ code: 'CARD_VIEW_LOCKED' }) });
    expect(charges.pinForCardView).toHaveBeenCalledTimes(5);
    // 24 h desde el primer intento: los siguientes no la alargan.
    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledWith('np:card-pin-view:fails:w-1', 24 * 60 * 60);
  });

  it('varias a la vez: cada intento cuenta ANTES de mirar el PIN, así que nunca se miran más de 5', async () => {
    const { service, charges } = withPin();
    const out = await Promise.allSettled(Array.from({ length: 8 }, () => service.viewWithPin(TOKEN, '1111', NOW)));
    expect(charges.pinForCardView).toHaveBeenCalledTimes(5);
    const statuses = out.map((o) => (o.status === 'rejected' ? (o.reason as { status?: number }).status : 200));
    expect(statuses.filter((s) => s === 422)).toHaveLength(4);
    expect(statuses.filter((s) => s === 429)).toHaveLength(4);
  });

  it('con el PIN bueno, los fallos de antes se borran; sin Redis, no se deja ver (503)', async () => {
    const { service, redis } = withPin();
    await expect(service.viewWithPin(TOKEN, '1111', NOW)).rejects.toMatchObject({ status: 422 });
    await expect(service.viewWithPin(TOKEN, '2468', NOW)).resolves.toMatchObject({ balanceCents: 3_540 });
    expect(redis.del).toHaveBeenCalledWith('np:card-pin-view:fails:w-1');
    redis.incr.mockRejectedValueOnce(new Error('caído'));
    await expect(service.viewWithPin(TOKEN, '2468', NOW)).rejects.toMatchObject({ status: 503 });
  });
});

describe('«Ver mi saldo con mi PIN»: su freno por IP y por ficha e IP', () => {
  it('POST /w/card/:token/pin lleva su propio freno, con tope por ficha (el :token) e IP', () => {
    const proto = PublicWalletCardController.prototype as unknown as Record<string, () => void>;
    expect(Reflect.getMetadata(IP_RATE_LIMIT_META, proto.pinView)).toEqual(CARD_PIN_VIEW_LIMIT);
    expect(CARD_PIN_VIEW_LIMIT).toMatchObject({ scope: 'wallet-card-pin', perKey: { param: 'token', max: 8 } });
  });
});
