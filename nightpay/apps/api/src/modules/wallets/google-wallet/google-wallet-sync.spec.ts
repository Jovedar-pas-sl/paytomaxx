import { describe, it, expect, vi } from 'vitest';
import { findDuePasses, GOOGLE_WALLET_SYNC_BATCH, GOOGLE_WALLET_SYNC_EVERY_MS, syncAction, type DuePass } from './google-wallet-sync';

function pass(o: Partial<DuePass> = {}): DuePass {
  return {
    id: 'p-1',
    objectId: 'issuer.oxiopay_saldo-abc',
    lastSyncedBalanceCents: 20_000,
    lastSyncedStatus: 'ACTIVE',
    balanceCents: 20_000,
    status: 'ACTIVE',
    merged: false,
    sameLink: true,
    qrToken: 'tok',
    venueName: 'Luna',
    ...o,
  };
}

describe('repaso de pases: qué hacer con cada uno', () => {
  it('saldo distinto del que tiene el pase → actualizar', () => {
    expect(syncAction(pass({ balanceCents: 15_000 }))).toBe('update');
  });

  it('estado distinto (devuelto, caducado, gastado…) → actualizar', () => {
    expect(syncAction(pass({ status: 'REFUNDED', balanceCents: 20_000 }))).toBe('update');
    expect(syncAction(pass({ status: 'DEPLETED', merged: true }))).toBe('update');
  });

  it('el dueño dio un enlace nuevo al saldo → el pase viejo se apaga (aunque el saldo cambiara)', () => {
    expect(syncAction(pass({ sameLink: false }))).toBe('revoke');
    expect(syncAction(pass({ sameLink: false, balanceCents: 1 }))).toBe('revoke');
  });

  it('todo igual → nada', () => {
    expect(syncAction(pass())).toBe('skip');
  });

  it('cada ~2 min y como mucho un lote por vuelta', () => {
    expect(GOOGLE_WALLET_SYNC_EVERY_MS).toBe(120_000);
    expect(GOOGLE_WALLET_SYNC_BATCH).toBeGreaterThan(0);
  });

  it('la consulta: solo Google, sin apagar, y saldo, estado o enlace distintos; el límite va como parámetro', async () => {
    const $queryRaw = vi.fn().mockResolvedValue([]);
    await findDuePasses({ $queryRaw } as never, 7);
    const [strings, ...values] = $queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join('?');
    expect(sql).toContain(`p.provider = 'GOOGLE'`);
    expect(sql).toContain(`p."revokedAt" IS NULL`);
    expect(sql).toContain(`p."lastSyncedBalanceCents" <> w."balanceCents"`);
    expect(sql).toContain(`p."lastSyncedStatus" <> w.status`);
    expect(sql).toContain(`encode(sha256(convert_to(w."qrToken", 'UTF8')), 'hex')`);
    // Los que fallan (intentados hace poco) van al final y no tapan a los demás.
    expect(sql).toContain('ORDER BY p."lastAttemptAt" ASC NULLS FIRST, p."lastSyncedAt" ASC');
    expect(values).toEqual([7]);
  });
});
