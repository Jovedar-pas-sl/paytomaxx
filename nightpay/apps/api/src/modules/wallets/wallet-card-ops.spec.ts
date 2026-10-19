import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  attachCard,
  isIssuedCard,
  moveWalletCards,
  purgePendingCodes,
  returnWalletCards,
} from './wallet-card-ops';

/**
 * El ciclo de vida de la ficha: dada (con su evento y el local de ese
 * momento), devuelta, sustituida (perdida, fuera del stock), movida al saldo
 * bueno al sumar dos saldos, solo de su grupo de locales, y los códigos sin
 * grabar se borran pasado un día. Base en memoria.
 */

type Row = Record<string, unknown>;

function db(cards: Row[], venues: Record<string, string | null> = { sala: 'grupo', norte: 'grupo', neon: 'otro' }) {
  const rows = new Map(cards.map((c) => [String(c.id), { walletId: null, uid: null, venueId: 'sala', ...c } as Row]));
  const events: Row[] = [];
  const matches = (r: Row, where: Row): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'NOT') return !matches(r, v as Row);
      if (v && typeof v === 'object' && 'in' in (v as Row)) return ((v as { in: unknown[] }).in).includes(r[k]);
      return r[k] === v;
    });
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('FROM wallet_cards')) return [...rows.values()].filter((r) => r.token === values[0]);
      return [{ id: values[0] }];
    }),
    $executeRaw: vi.fn(async () => 3),
    venue: { findUnique: vi.fn(async (a: { where: { id: string } }) => ({ walletGroup: venues[a.where.id] ?? null })) },
    clientWallet: { findUnique: vi.fn(async () => ({ status: 'DEPLETED', balanceCents: 0 })) },
    walletCard: {
      findMany: vi.fn(async (a: { where: Row }) => [...rows.values()].filter((r) => matches(r, a.where)).map((r) => ({ id: r.id }))),
      update: vi.fn(async (a: { where: { id: string }; data: Row }) => rows.set(a.where.id, { ...rows.get(a.where.id), ...a.data })),
      updateMany: vi.fn(async (a: { where: Row; data: Row }) => {
        const hit = [...rows.values()].filter((r) => matches(r, a.where));
        hit.forEach((r) => rows.set(String(r.id), { ...r, ...a.data }));
        return { count: hit.length };
      }),
    },
    walletCardEvent: {
      createMany: vi.fn(async (a: { data: Row[] }) => {
        events.push(...a.data);
        return { count: a.data.length };
      }),
    },
  };
  const prisma = { acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { prisma, tx, rows, events };
}

const TOKEN = 'q3VbX9kLmN2pR7sT4wYz1A';

describe('la ficha dada a un saldo', () => {
  it('ISSUED (o ACTIVE del API anterior) con saldo; sin saldo, no', () => {
    expect(isIssuedCard({ status: 'ISSUED', walletId: 'w' })).toBe(true);
    expect(isIssuedCard({ status: 'ACTIVE', walletId: 'w' })).toBe(true);
    expect(isIssuedCard({ status: 'ACTIVE', walletId: null })).toBe(false);
    expect(isIssuedCard({ status: 'RETURNED', walletId: null })).toBe(false);
  });

  it('dar una ficha a un saldo que ya tenía otra: la nueva ISSUED, la vieja perdida (no al stock); eventos con el local', async () => {
    const { prisma, rows, events } = db([
      { id: 'nueva', token: TOKEN, status: 'STOCK' },
      { id: 'vieja', token: 'otraFichaDelCliente01', status: 'ISSUED', walletId: 'w-1' },
    ]);
    const replaced = await attachCard(prisma as never, { walletId: 'w-1', venueId: 'norte', card: TOKEN, uid: '04a23b5c1d8000', by: { userId: 'u-1' } });
    expect(replaced).toBe(1);
    expect(rows.get('nueva')).toMatchObject({ status: 'ISSUED', walletId: 'w-1', uid: '04A23B5C1D8000', venueId: 'norte' });
    expect(rows.get('vieja')).toMatchObject({ status: 'LOST', walletId: null });
    expect(events.map((e) => [e.cardId, e.kind, e.venueId])).toEqual([
      ['vieja', 'LOST', 'norte'],
      ['nueva', 'ISSUED', 'norte'],
    ]);
  });

  it('la de un saldo ya gastado vuelve a salir: cuenta como devuelta y dada otra vez (dos entregas en la noche)', async () => {
    const { prisma, events } = db([{ id: 'c', token: TOKEN, status: 'ISSUED', walletId: 'w-gastado' }]);
    await attachCard(prisma as never, { walletId: 'w-2', venueId: 'sala', card: TOKEN, uid: null, by: { userId: null, terminalId: 't-1' } });
    expect(events.map((e) => [e.kind, e.walletId, e.terminalId])).toEqual([
      ['RETURNED', 'w-gastado', 't-1'],
      ['ISSUED', 'w-2', 't-1'],
    ]);
  });

  it('una ficha de otro grupo de locales no se da (como en el stock)', async () => {
    const { prisma, rows } = db([{ id: 'c', token: TOKEN, status: 'STOCK', venueId: 'neon' }]);
    await expect(
      attachCard(prisma as never, { walletId: 'w-1', venueId: 'sala', card: TOKEN, uid: null, by: { userId: 'u-1' } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rows.get('c')).toMatchObject({ status: 'STOCK', walletId: null });
  });
});

describe('«Me voy» y saldos sumados', () => {
  it('devuelto: sus fichas vuelven al stock del local que lo devuelve, con su evento', async () => {
    const { tx, rows, events } = db([{ id: 'c', token: TOKEN, status: 'ACTIVE', walletId: 'w-1', venueId: 'norte' }]);
    await expect(returnWalletCards(tx as never, 'w-1', 'sala', { userId: 'u-1' })).resolves.toBe(1);
    expect(rows.get('c')).toMatchObject({ status: 'RETURNED', walletId: null, venueId: 'sala' });
    expect(events).toEqual([expect.objectContaining({ cardId: 'c', kind: 'RETURNED', walletId: 'w-1', venueId: 'sala', byUserId: 'u-1' })]);
  });

  it('sumado a otro saldo: su ficha pasa al bueno; si el bueno ya tenía una, esa queda sustituida', async () => {
    const { tx, rows, events } = db([
      { id: 'de-la-recarga', token: TOKEN, status: 'ISSUED', walletId: 'w-nuevo' },
      { id: 'del-cliente', token: 'otraFichaDelCliente01', status: 'ISSUED', walletId: 'w-bueno' },
    ]);
    await expect(moveWalletCards(tx as never, { walletId: 'w-nuevo', venueId: 'sala' }, 'w-bueno')).resolves.toBe(1);
    expect(rows.get('de-la-recarga')).toMatchObject({ status: 'ISSUED', walletId: 'w-bueno' });
    expect(rows.get('del-cliente')).toMatchObject({ status: 'LOST', walletId: null });
    expect(events.map((e) => [e.cardId, e.kind])).toEqual([['del-cliente', 'LOST']]);
  });

  it('sin ficha que mover, nada', async () => {
    const { tx, events } = db([]);
    await expect(moveWalletCards(tx as never, { walletId: 'w-nuevo', venueId: 'sala' }, 'w-bueno')).resolves.toBe(0);
    expect(events).toEqual([]);
  });
});

describe('códigos pedidos y nunca grabados', () => {
  it('se borran los de este local con más de un día, sin saldo, sin uso y sin eventos (de 200 en 200)', async () => {
    const { tx } = db([]);
    const now = new Date('2026-10-21T10:00:00Z');
    await expect(purgePendingCodes(tx as never, 'sala', now)).resolves.toBe(3);
    const [strings, ...values] = tx.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join('?');
    expect(sql).toMatch(/DELETE FROM wallet_cards/);
    expect(sql).toMatch(/status = 'STOCK' AND c\."stockedAt" IS NULL/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM wallet_card_events/);
    expect(values).toEqual(['sala', new Date('2026-10-20T10:00:00Z'), 200]);
  });
});
