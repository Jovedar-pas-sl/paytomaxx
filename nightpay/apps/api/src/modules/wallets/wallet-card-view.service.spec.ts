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
  return { service: new WalletCardViewService(prisma as never, keys as never), findUnique, keys };
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
    const { service, keys } = make();
    await expect(service.pageView(token)).resolves.toEqual({ kind: 'locked', codeHint: 'K7Q-•••' });
    keys.hasPasskey.mockResolvedValue(false);
    await expect(service.pageView(token)).resolves.toEqual({ kind: 'setup', codeHint: 'K7Q-•••' });
    expect(JSON.stringify(await service.pageView(token))).not.toContain(wallet.qrToken);
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
