import { describe, it, expect, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { lockLiveWallet, mergedWalletIds, type LockedWallet } from './wallet-merge-chain';

/**
 * Saldos sumados (una recarga nueva se suma al saldo de siempre del cliente):
 * lo que vuelva a la recarga va al saldo que sobrevive, y la cadena rota o
 * en bucle se corta con un 409 en vez de dar vueltas.
 */

const SALA = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a01'; // Sala Bambú (Madrid)
const RECARGA = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f71'; // recarga de esta noche
const DE_SIEMPRE = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70'; // el saldo con su Face ID

function wallet(id: string, o: Partial<LockedWallet> = {}): LockedWallet {
  return { id, tenantId: SALA, walletGroup: 'grupo-bambu', balanceCents: 0, status: 'ACTIVE', shortCode: null, mergedIntoId: null, ...o };
}

/**
 * client_wallets de mentira. `peek` = lo que ve la lectura sin bloquear (por
 * defecto, lo mismo que la fila): así se simula que se suma justo entre medias.
 */
function fakeTx(rows: LockedWallet[], peek: Record<string, string | null> = {}) {
  const queries: Prisma.Sql[] = [];
  const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = Prisma.sql(strings, ...values);
    queries.push(q);
    if (q.text.includes('WITH RECURSIVE')) return [{ id: DE_SIEMPRE }, { id: RECARGA }];
    const id = String(values[0]);
    const row = rows.find((r) => r.id === id);
    if (q.text.includes('FOR UPDATE')) return row ? [{ ...row }] : [];
    if (!row) return [];
    return [{ mergedIntoId: id in peek ? peek[id] : row.mergedIntoId }];
  });
  return {
    tx: { $queryRaw } as unknown as Parameters<typeof lockLiveWallet>[0],
    raw: $queryRaw,
    queries,
    locked: () => queries.filter((q) => q.text.includes('FOR UPDATE')).map((q) => q.values[0]),
  };
}

/** w-0 → w-1 → … → w-n (cada una sumada a la siguiente; w-n es la que sobrevive). */
function chain(n: number): LockedWallet[] {
  return Array.from({ length: n + 1 }, (_, i) => wallet(`w-${i}`, { mergedIntoId: i < n ? `w-${i + 1}` : null, balanceCents: i === n ? 9_000 : 0 }));
}

describe('el saldo donde está hoy el dinero (lockLiveWallet)', () => {
  it('un saldo sin sumar: él mismo, bloqueado', async () => {
    const { tx, queries, locked } = fakeTx([wallet(DE_SIEMPRE, { balanceCents: 12_000, shortCode: 'K7Q4M2' })]);
    await expect(lockLiveWallet(tx, DE_SIEMPRE)).resolves.toEqual(wallet(DE_SIEMPRE, { balanceCents: 12_000, shortCode: 'K7Q4M2' }));
    expect(locked()).toEqual([DE_SIEMPRE]);
    expect(queries.at(-1)!.text).toMatch(/FROM client_wallets WHERE id = \$1::uuid FOR UPDATE/);
  });

  it('una recarga sumada: el saldo al que se sumó; solo se bloquea ese, no la recarga', async () => {
    const { tx, locked } = fakeTx([
      wallet(RECARGA, { status: 'DEPLETED', mergedIntoId: DE_SIEMPRE }),
      wallet(DE_SIEMPRE, { balanceCents: 12_000 }),
    ]);
    await expect(lockLiveWallet(tx, RECARGA)).resolves.toMatchObject({ id: DE_SIEMPRE, balanceCents: 12_000 });
    expect(locked()).toEqual([DE_SIEMPRE]);
  });

  it('si se suma a otro justo mientras se bloquea, se sigue la cadena hasta el que sobrevive', async () => {
    const { tx, locked } = fakeTx(
      [wallet(RECARGA, { status: 'DEPLETED', mergedIntoId: DE_SIEMPRE }), wallet(DE_SIEMPRE, { balanceCents: 15_000 })],
      { [RECARGA]: null }, // al mirarla aún no estaba sumada
    );
    await expect(lockLiveWallet(tx, RECARGA)).resolves.toMatchObject({ id: DE_SIEMPRE, balanceCents: 15_000, mergedIntoId: null });
    expect(locked()).toEqual([RECARGA, DE_SIEMPRE]);
  });

  it('un saldo que no existe (o que desaparece al bloquearlo) → null', async () => {
    await expect(lockLiveWallet(fakeTx([]).tx, RECARGA)).resolves.toBeNull();
    // La cadena apunta a un saldo que ya no está.
    const rota = fakeTx([wallet(RECARGA, { mergedIntoId: 'd4e5f6a7-0000-4d0e-8f1a-000000000000' })]);
    await expect(lockLiveWallet(rota.tx, RECARGA)).resolves.toBeNull();
    // Se ve al mirarla, pero al ir a bloquearla ya no está.
    const borrada = fakeTx([]);
    borrada.raw.mockResolvedValueOnce([{ mergedIntoId: null }]);
    await expect(lockLiveWallet(borrada.tx, RECARGA)).resolves.toBeNull();
  });

  it('hasta 10 saltos se resuelve; con 11, o en bucle, se corta con un 409', async () => {
    await expect(lockLiveWallet(fakeTx(chain(10)).tx, 'w-0')).resolves.toMatchObject({ id: 'w-10', balanceCents: 9_000 });
    await expect(lockLiveWallet(fakeTx(chain(11)).tx, 'w-0')).rejects.toBeInstanceOf(ConflictException);

    const bucle = fakeTx([wallet(RECARGA, { mergedIntoId: DE_SIEMPRE }), wallet(DE_SIEMPRE, { mergedIntoId: RECARGA })]);
    await expect(lockLiveWallet(bucle.tx, RECARGA)).rejects.toBeInstanceOf(ConflictException);
    expect(bucle.locked()).toEqual([]);
    expect(bucle.raw).toHaveBeenCalledTimes(11);
  });

  it('en bucle visto solo al bloquear (se suman entre sí a la vez): también se corta', async () => {
    const { tx } = fakeTx(
      [wallet(RECARGA, { mergedIntoId: DE_SIEMPRE }), wallet(DE_SIEMPRE, { mergedIntoId: RECARGA })],
      { [RECARGA]: null, [DE_SIEMPRE]: null },
    );
    await expect(lockLiveWallet(tx, RECARGA)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('el saldo y los que se sumaron a él (mergedWalletIds)', () => {
  it('una sola consulta recursiva desde el saldo, con el tope de saltos como parámetro', async () => {
    const { tx, queries } = fakeTx([]);
    await expect(mergedWalletIds(tx, DE_SIEMPRE)).resolves.toEqual([DE_SIEMPRE, RECARGA]);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toMatch(/WITH RECURSIVE chain[\s\S]*WHERE id = \$1::uuid[\s\S]*"mergedIntoId" = c\.id[\s\S]*c\.hops < \$2/);
    expect(queries[0]!.values).toEqual([DE_SIEMPRE, 10]);
  });
});
