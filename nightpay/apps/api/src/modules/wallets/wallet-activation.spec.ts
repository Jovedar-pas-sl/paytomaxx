import { describe, it, expect, vi } from 'vitest';
import { reopenData } from './wallet-activation';

/** tx de mentira: dice qué códigos tiene ya otro saldo activo. */
function txWithTaken(taken: string[]) {
  return {
    $queryRaw: vi.fn().mockImplementation(async (_sql: TemplateStringsArray, code: string) =>
      taken.includes(code) ? [{ id: 'otro' }] : [],
    ),
  };
}

describe('reabrir un saldo (vuelve a tener dinero)', () => {
  it('si ya está activo no se toca nada', async () => {
    const tx = txWithTaken([]);
    expect(await reopenData(tx, { id: 'w-1', shortCode: 'K7Q4M2', status: 'ACTIVE' })).toEqual({});
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('a 0 o cerrado y con su código libre: activo con el mismo código', async () => {
    const tx = txWithTaken([]);
    expect(await reopenData(tx, { id: 'w-1', shortCode: 'K7Q4M2', status: 'DEPLETED' })).toEqual({
      status: 'ACTIVE',
      shortCode: 'K7Q4M2',
    });
  });

  it('su código lo tiene ya otro cliente activo: se le da uno nuevo (si no, choca con el índice único)', async () => {
    const tx = txWithTaken(['K7Q4M2']);
    const out = await reopenData(tx, { id: 'w-1', shortCode: 'K7Q4M2', status: 'REFUNDED' });
    expect(out.status).toBe('ACTIVE');
    expect(out.shortCode).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(out.shortCode).not.toBe('K7Q4M2');
    // Se mira entre los activos y sin contar el propio saldo.
    const sql = (tx.$queryRaw.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(sql).toMatch(/"shortCode" = \?/);
    expect(sql).toMatch(/status = 'ACTIVE'/);
    expect(sql).toMatch(/id <> \?::uuid/);
  });

  it('un saldo viejo sin código sigue sin código', async () => {
    const tx = txWithTaken([]);
    expect(await reopenData(tx, { id: 'w-1', shortCode: null, status: 'DEPLETED' })).toEqual({ status: 'ACTIVE' });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('si no hay manera de dar con un código libre, error claro (no el del índice)', async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ id: 'otro' }]) };
    await expect(reopenData(tx, { id: 'w-1', shortCode: 'K7Q4M2', status: 'DEPLETED' })).rejects.toThrow(/código libre/);
  });
});
