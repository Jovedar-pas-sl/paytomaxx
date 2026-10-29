import { describe, expect, it, vi } from 'vitest';
import { ConflictException, GoneException } from '@nestjs/common';
import {
  ACTIVATION_TOKEN_TTL_MS,
  activationPath,
  activationStateOf,
  activationTokenHash,
  isActivationToken,
  issueActivationToken,
  newActivationToken,
  spendActivationToken,
} from './wallet-activation-token';

/** El token del QR de activación (M-2): aparte del enlace del saldo, un solo uso y 10 min. */

const NOW = new Date('2026-10-29T23:00:00Z');

describe('el token de activación', () => {
  it('aleatorio de 192 bits (32 caracteres base64url), distinto cada vez, y su forma se comprueba', () => {
    const a = newActivationToken();
    const b = newActivationToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(24);
    expect(a).not.toBe(b);
    expect(isActivationToken(a)).toBe(true);
    for (const bad of [undefined, 42, '', 'corto', `${a}x`, `${a.slice(0, 31)}/`, '../../etc/passwd']) {
      expect(isActivationToken(bad)).toBe(false);
    }
  });

  it('en la base solo su sha256 (hex): con el hash no se rehace el enlace', () => {
    const t = newActivationToken();
    expect(activationTokenHash(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(activationTokenHash(t)).not.toContain(t);
    expect(activationTokenHash(t)).toBe(activationTokenHash(t));
  });

  it('el enlace es /w/a/<token> (no el del saldo)', () => {
    expect(activationPath('abc')).toBe('/w/a/abc');
  });

  it('estado: vigente, usado o caducado (anulado cuenta como caducado); sin fila, null', () => {
    const base = { usedAt: null, revokedAt: null, expiresAt: new Date(NOW.getTime() + 60_000) };
    expect(activationStateOf(base, NOW)).toBe('ok');
    expect(activationStateOf({ ...base, usedAt: NOW }, NOW)).toBe('used');
    expect(activationStateOf({ ...base, revokedAt: NOW }, NOW)).toBe('expired');
    expect(activationStateOf({ ...base, expiresAt: NOW }, NOW)).toBe('expired');
    // Usado y además caducado: «ya se ha usado» (es lo que pasó primero).
    expect(activationStateOf({ ...base, usedAt: NOW, expiresAt: new Date(0) }, NOW)).toBe('used');
    expect(activationStateOf(null, NOW)).toBeNull();
  });
});

function fakeTx(o: { spend?: number; row?: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date; walletId: string } | null } = {}) {
  return {
    walletActivationToken: {
      updateMany: vi.fn().mockResolvedValue({ count: o.spend ?? 1 }),
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(o.row === undefined ? { walletId: 'w-1', usedAt: NOW, revokedAt: null, expiresAt: NOW } : o.row),
    },
  };
}

describe('emitir', () => {
  it('anula los anteriores sin usar de ese saldo y guarda el nuevo (hash, saldo, quién, dónde, cómo, 10 min)', async () => {
    const tx = fakeTx();
    const out = await issueActivationToken(tx as never, { walletId: 'w-1', venueId: 'v-1', issuedById: 'u-1', via: 'reception', now: NOW });
    expect(tx.walletActivationToken.updateMany).toHaveBeenCalledWith({
      where: { walletId: 'w-1', usedAt: null, revokedAt: null },
      data: { revokedAt: NOW },
    });
    expect(tx.walletActivationToken.create).toHaveBeenCalledWith({
      data: {
        walletId: 'w-1',
        tokenHash: activationTokenHash(out.token),
        venueId: 'v-1',
        issuedById: 'u-1',
        via: 'reception',
        createdAt: NOW,
        expiresAt: new Date(NOW.getTime() + ACTIVATION_TOKEN_TTL_MS),
      },
    });
    expect(ACTIVATION_TOKEN_TTL_MS).toBe(10 * 60_000);
    expect(out.expiresAt).toEqual(new Date(NOW.getTime() + ACTIVATION_TOKEN_TTL_MS));
    // Primero se anulan los viejos, luego el nuevo (el nuevo no se anula a sí mismo).
    expect(tx.walletActivationToken.updateMany.mock.invocationCallOrder[0]).toBeLessThan(tx.walletActivationToken.create.mock.invocationCallOrder[0]!);
  });
});

describe('gastar (dentro de la transacción del registro)', () => {
  it('solo si está vigente: lo marca usado (y para qué) y dice de qué saldo es', async () => {
    const tx = fakeTx({ row: { walletId: 'w-1', usedAt: NOW, revokedAt: null, expiresAt: new Date(NOW.getTime() + 1) } });
    await expect(spendActivationToken(tx as never, 'tok', 'pin', NOW)).resolves.toEqual({ walletId: 'w-1' });
    expect(tx.walletActivationToken.updateMany).toHaveBeenCalledWith({
      where: { tokenHash: activationTokenHash('tok'), usedAt: null, revokedAt: null, expiresAt: { gt: NOW } },
      data: { usedAt: NOW, usedFor: 'pin' },
    });
  });

  it('ya usado (otro registro llegó antes): 409 ACTIVATION_USED, «Este enlace ya se ha usado»', async () => {
    const tx = fakeTx({ spend: 0, row: { walletId: 'w-1', usedAt: NOW, revokedAt: null, expiresAt: new Date(NOW.getTime() + 60_000) } });
    const err = await spendActivationToken(tx as never, 'tok', 'passkey', NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'ACTIVATION_USED', message: 'Este enlace ya se ha usado. Pide otro en recepción.' });
  });

  it('caducado, anulado o que no existe: 410 ACTIVATION_EXPIRED, «Este enlace ha caducado»', async () => {
    for (const row of [
      { walletId: 'w-1', usedAt: null, revokedAt: null, expiresAt: new Date(NOW.getTime() - 1) },
      { walletId: 'w-1', usedAt: null, revokedAt: NOW, expiresAt: new Date(NOW.getTime() + 60_000) },
      null,
    ]) {
      const err = await spendActivationToken(fakeTx({ spend: 0, row }) as never, 'tok', 'passkey', NOW).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GoneException);
      expect((err as GoneException).getResponse()).toMatchObject({ code: 'ACTIVATION_EXPIRED', message: 'Este enlace ha caducado. Pide otro en recepción.' });
    }
  });
});
