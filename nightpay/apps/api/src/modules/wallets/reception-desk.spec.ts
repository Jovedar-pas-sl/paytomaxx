import { describe, it, expect } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { readReceptionDesk } from './reception-desk';

/**
 * Recepción exprés: el NFC acercado (o el código) → nuevo o el saldo que
 * tiene, su número y lo que se le puede devolver en efectivo.
 */

const SALA = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a01';
const OTRO = '9a1c7e55-2b3d-4e6f-8a90-1b2c3d4e5f60';
const FICHA = 'q3VbX9kLmN2pR7sT4wYz1A';
const venue = { id: SALA, walletGroup: null };

type Card = { id: string; uid: string | null; walletId: string | null; status: string; venueId: string | null; number: number };
type Wallet = {
  id: string;
  tenantId: string;
  walletGroup: string | null;
  shortCode: string | null;
  balanceCents: number;
  status: string;
  pinHash: string | null;
  blockedAt: Date | null;
  closeRequestedAt: Date | null;
  mergedIntoId: string | null;
};

const wallet = (o: Partial<Wallet> = {}): Wallet => ({
  id: 'w-1',
  tenantId: SALA,
  walletGroup: null,
  shortCode: 'R3D8LP',
  balanceCents: 3_500,
  status: 'ACTIVE',
  pinHash: 'hash',
  blockedAt: null,
  closeRequestedAt: null,
  mergedIntoId: null,
  ...o,
});

/** Una base de mentira con sus fichas, sus saldos y el efectivo que entró (wallet-cash-limits). */
function db(opts: { cards?: Card[]; wallets?: Wallet[]; cashIn?: number }) {
  const cards = opts.cards ?? [];
  const wallets = opts.wallets ?? [];
  return {
    walletCard: {
      findUnique: async ({ where }: { where: { token: string } }) => (where.token === FICHA ? (cards[0] ?? null) : null),
      findFirst: async ({ where }: { where: { walletId: string } }) => cards.find((c) => c.walletId === where.walletId) ?? null,
    },
    clientWallet: {
      findUnique: async ({ where }: { where: { id: string } }) => wallets.find((w) => w.id === where.id) ?? null,
      findFirst: async ({ where }: { where: { shortCode: string } }) =>
        wallets.find((w) => w.shortCode === where.shortCode && w.status === 'ACTIVE') ?? null,
    },
    venue: { findUnique: async () => ({ walletGroup: null }) },
    $queryRaw: async () => [{ inCents: opts.cashIn ?? 0, inWindowCents: opts.cashIn ?? 0, outCents: 0, outWindowCents: 0 }],
  };
}

const card = (o: Partial<Card> = {}): Card => ({ id: 'c-1', uid: '04A23B11', walletId: null, status: 'STOCK', venueId: SALA, number: 522, ...o });

describe('el NFC acercado en la recepción', () => {
  it('del stock: nuevo, con su número', async () => {
    const tx = db({ cards: [card()] });
    await expect(readReceptionDesk(tx as never, venue, { card: FICHA, uid: '04:a2:3b:11' })).resolves.toEqual({
      kind: 'new',
      fichaNumber: 522,
    });
  });

  it('de un saldo vivo: lo que tiene, su código y lo que sale en efectivo (solo lo que entró en efectivo)', async () => {
    const tx = db({ cards: [card({ status: 'ISSUED', walletId: 'w-1', number: 388 })], wallets: [wallet()], cashIn: 2_000 });
    const view = await readReceptionDesk(tx as never, venue, { card: FICHA });
    expect(view).toMatchObject({
      kind: 'saldo',
      walletId: 'w-1',
      code: 'R3D-8LP',
      balanceCents: 3_500,
      hasPin: true,
      isHomeVenue: true,
      blocked: false,
      closeRequested: false,
      cashOutCents: 2_000,
      fichaNumber: 388,
    });
    expect(view.kind === 'saldo' ? view.cashOutNote : null).toMatch(/15,00 € entraron con tarjeta/);
  });

  it('un saldo a cero sigue siendo suyo (se recarga el mismo); uno ya devuelto deja el NFC libre', async () => {
    const empty = db({ cards: [card({ status: 'ISSUED', walletId: 'w-1' })], wallets: [wallet({ balanceCents: 0, status: 'DEPLETED' })] });
    await expect(readReceptionDesk(empty as never, venue, { card: FICHA })).resolves.toMatchObject({ kind: 'saldo', balanceCents: 0, cashOutCents: 0, cashOutNote: null });
    const closed = db({ cards: [card({ status: 'ISSUED', walletId: 'w-1' })], wallets: [wallet({ balanceCents: 0, status: 'REFUNDED' })] });
    await expect(readReceptionDesk(closed as never, venue, { card: FICHA })).resolves.toEqual({ kind: 'new', fichaNumber: 522 });
  });

  it('un saldo sumado a otro: el de hoy, con su dinero', async () => {
    const tx = db({
      cards: [card({ status: 'ISSUED', walletId: 'w-old' })],
      wallets: [wallet({ id: 'w-old', balanceCents: 0, mergedIntoId: 'w-1' }), wallet({ balanceCents: 8_000 })],
      cashIn: 8_000,
    });
    await expect(readReceptionDesk(tx as never, venue, { card: FICHA })).resolves.toMatchObject({ walletId: 'w-1', balanceCents: 8_000, cashOutCents: 8_000 });
  });

  it('perdido, bloqueado, copiado o de otro local: no se usa', async () => {
    await expect(readReceptionDesk(db({ cards: [card({ status: 'LOST' })] }) as never, venue, { card: FICHA })).rejects.toBeInstanceOf(ConflictException);
    await expect(readReceptionDesk(db({ cards: [card({ status: 'BLOCKED' })] }) as never, venue, { card: FICHA })).rejects.toBeInstanceOf(ConflictException);
    await expect(readReceptionDesk(db({ cards: [card()] }) as never, venue, { card: FICHA, uid: 'FFFFFFFF' })).rejects.toThrow(/copiado/);
    await expect(readReceptionDesk(db({ cards: [card({ venueId: OTRO })] }) as never, venue, { card: FICHA })).rejects.toBeInstanceOf(NotFoundException);
    await expect(readReceptionDesk(db({}) as never, venue, { card: FICHA })).rejects.toBeInstanceOf(NotFoundException);
    await expect(readReceptionDesk(db({}) as never, venue, { card: 'no-es-nuestra' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('el código tecleado', () => {
  it('su saldo, con el número de su NFC si tiene', async () => {
    const tx = db({ cards: [card({ status: 'ISSUED', walletId: 'w-1', number: 417 })], wallets: [wallet({ shortCode: 'K7Q4M2', balanceCents: 8_000 })] });
    await expect(readReceptionDesk(tx as never, venue, { code: 'k7q-4m2' })).resolves.toMatchObject({
      kind: 'saldo',
      code: 'K7Q-4M2',
      balanceCents: 8_000,
      fichaNumber: 417,
    });
    const noCard = db({ wallets: [wallet({ shortCode: 'K7Q4M2' })] });
    await expect(readReceptionDesk(noCard as never, venue, { code: 'K7Q4M2' })).resolves.toMatchObject({ fichaNumber: null });
  });

  it('mal tecleado, cerrado o de otro grupo: no hay saldo', async () => {
    await expect(readReceptionDesk(db({}) as never, venue, { code: 'K7Q' })).rejects.toThrow(/6 letras/);
    await expect(readReceptionDesk(db({ wallets: [wallet({ shortCode: 'K7Q4M2', status: 'REFUNDED' })] }) as never, venue, { code: 'K7Q4M2' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      readReceptionDesk(db({ wallets: [wallet({ shortCode: 'K7Q4M2', tenantId: OTRO, walletGroup: 'g' })] }) as never, venue, { code: 'K7Q4M2' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
