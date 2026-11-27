import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { CLIENT_CARD_BLOCKED_ACTION, WalletLostCardService } from './wallet-lost-card.service';

const wallet = { id: 'w1', tenantId: 'home-venue', shortCode: 'K7Q4M2', balanceCents: 3_000 };

function make(o: { passkey?: boolean; owner?: string; cards?: Array<{ id: string; venueId: string | null }>; wallet?: typeof wallet | null } = {}) {
  const tx = {
    $queryRaw: vi.fn(async () => (o.wallet === null ? [] : [o.wallet ?? wallet])),
    walletCard: {
      findMany: vi.fn(async () => o.cards ?? [{ id: 'card-1', venueId: 'issuing-venue' }]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    walletCardEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
  };
  const prisma = { acrossVenues: (fn: (t: unknown) => unknown) => fn(tx) };
  const audit = { log: vi.fn(async () => undefined) };
  const passkeys = {
    hasPasskey: vi.fn(async () => o.passkey ?? true),
    challenge: vi.fn(async () => ({ challenge: 'reto' })),
    verify: vi.fn(async () => o.owner ?? 'w1'),
  };
  // Los códigos del móvil (OXC1:) del saldo: se anulan tras bloquear el NFC.
  const liveCodes = { dropWallet: vi.fn(async (_walletId: string) => undefined) };
  return { service: new WalletLostCardService(prisma as never, audit as never, passkeys as never, liveCodes as never), tx, audit, passkeys, liveCodes };
}

describe('«He perdido mi NFC»', () => {
  it('el reto va atado a esta acción y a este saldo', async () => {
    const { service, passkeys } = make();
    await expect(service.challenge('w1', 'api.example')).resolves.toEqual({ challenge: 'reto' });
    expect(passkeys.challenge).toHaveBeenCalledWith('card-lost:w1', 'api.example');
  });

  it('con la passkey del saldo: el NFC queda bloqueado, con su evento, y el dueño lo ve en Incidencias', async () => {
    const { service, tx, audit, passkeys } = make();
    await expect(service.block('w1', 'api.example', { id: 'key' })).resolves.toEqual({ blockedCards: 1 });
    expect(passkeys.verify).toHaveBeenCalledWith('card-lost:w1', 'api.example', { id: 'key' });
    expect(tx.walletCard.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['card-1'] }, status: { in: ['ISSUED', 'ACTIVE'] } },
      data: { status: 'BLOCKED', blockedAt: expect.any(Date) },
    });
    expect(tx.walletCardEvent.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ cardId: 'card-1', walletId: 'w1', kind: 'BLOCKED', venueId: 'issuing-venue', byUserId: null })],
    });
    // El saldo se bloquea (FOR UPDATE) antes que el NFC, como al darlo.
    expect(String((tx.$queryRaw.mock.calls[0] as unknown[])[0])).toContain('FOR UPDATE');
    expect(audit.log).toHaveBeenCalledWith({
      action: CLIENT_CARD_BLOCKED_ACTION, tenantId: 'issuing-venue', actorId: null, targetType: 'ClientWallet', targetId: 'w1',
      payload: { via: 'client_passkey', cards: 1, code: 'K7Q-4M2', amountCents: 3_000 },
    });
  });

  it('bloqueado: anula los códigos del móvil del saldo (una vez, tras guardar)', async () => {
    const { service, liveCodes } = make();
    await expect(service.block('w1', undefined, {})).resolves.toEqual({ blockedCards: 1 });
    expect(liveCodes.dropWallet).toHaveBeenCalledTimes(1);
    expect(liveCodes.dropWallet).toHaveBeenCalledWith('w1');
  });

  it('si anular los códigos falla, el NFC queda bloqueado igual', async () => {
    const { service, audit, liveCodes } = make();
    liveCodes.dropWallet.mockRejectedValueOnce(new Error('redis caído'));
    await expect(service.block('w1', undefined, {})).resolves.toEqual({ blockedCards: 1 });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: CLIENT_CARD_BLOCKED_ACTION }));
    expect(liveCodes.dropWallet).toHaveBeenCalledTimes(1);
  });

  it('sin passkey, con otra, sin NFC activo o sin saldo: no anula códigos', async () => {
    const cases = [make({ passkey: false }), make({ owner: 'w2' }), make({ cards: [] }), make({ wallet: null })];
    for (const c of cases) {
      await expect(c.service.block('w1', undefined, {})).rejects.toBeDefined();
      expect(c.liveCodes.dropWallet).not.toHaveBeenCalled();
    }
  });

  it('un NFC sin local apunta la incidencia en el local del saldo', async () => {
    const { service, audit } = make({ cards: [{ id: 'c', venueId: null }] });
    await service.block('w1', undefined, {});
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'home-venue' }));
  });

  it('sin passkey no se hace aquí (con solo el enlace no se toca el NFC)', async () => {
    const { service, passkeys, tx } = make({ passkey: false });
    await expect(service.challenge('w1', undefined)).rejects.toMatchObject({ status: 409, response: { code: 'FACE_ID_NOT_SET' } });
    await expect(service.block('w1', undefined, {})).rejects.toMatchObject({ status: 409, response: { code: 'FACE_ID_NOT_SET' } });
    expect(passkeys.verify).not.toHaveBeenCalled();
    expect(tx.walletCard.updateMany).not.toHaveBeenCalled();
  });

  it('la passkey de otro saldo no bloquea este NFC; una firma mala tampoco', async () => {
    const other = make({ owner: 'w2' });
    await expect(other.service.block('w1', undefined, {})).rejects.toMatchObject({ status: 403, response: { code: 'FACE_ID_WRONG' } });
    expect(other.tx.walletCard.updateMany).not.toHaveBeenCalled();
    const bad = make();
    bad.passkeys.verify.mockRejectedValue(new ForbiddenException({ code: 'FACE_ID_FAILED' }));
    await expect(bad.service.block('w1', undefined, {})).rejects.toThrow(ForbiddenException);
    expect(bad.audit.log).not.toHaveBeenCalled();
  });

  it('sin NFC activo: 409 WALLET_NO_CARD y nada en el registro', async () => {
    const { service, tx, audit } = make({ cards: [] });
    await expect(service.block('w1', undefined, {})).rejects.toMatchObject({ status: 409, response: { code: 'WALLET_NO_CARD' } });
    expect(tx.walletCard.updateMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('saldo que ya no existe: 404', async () => {
    const { service } = make({ wallet: null });
    await expect(service.block('w1', undefined, {})).rejects.toMatchObject({ status: 404 });
  });
});
