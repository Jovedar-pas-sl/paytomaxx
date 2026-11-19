import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { WalletsService } from './wallets.service';

/**
 * Lo que enseñan los saldos: la lista y la ficha del panel (solo del local
 * que pregunta) y la vista pública por enlace, que no debe soltar nada que no
 * sea del cliente (ni el hash del PIN, ni su enlace, ni datos del personal).
 */

const SALA = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a01'; // Sala Bambú (Madrid)
const NORTE = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a02'; // Bambú Norte (Alcobendas), mismo grupo
const WALLET = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70';
const PIN_HASH = 's1$c2FsLWRlbC1waW4$aGFzaC1kZWwtcGluLWRlLWxhLWNsaWVudGE';
const QR_TOKEN = 'qrTokenDelClienteK7Q4M2xx';
const CARD_UID = '04A23B5C1D8000';

type Row = Record<string, unknown>;
const at = (iso: string) => new Date(iso);

/** Una fila de client_wallets como la devuelve la base (con todo lo sensible). */
function walletRow(o: Row = {}): Row {
  return {
    id: WALLET, tenantId: SALA, walletGroup: 'grupo-bambu', identifier: 'Mesa 4', shortCode: 'K7Q4M2', qrToken: QR_TOKEN,
    balanceCents: 8_500, status: 'ACTIVE', expiresAt: null, createdAt: at('2026-10-17T00:12:00Z'), closeRequestedAt: null,
    pinHash: PIN_HASH, pinFails: 2, pinLockedAt: null, pinSetById: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d03', blockedAt: null,
    _count: { consumptions: 3, passkeys: 1, cards: 1 },
    cards: [{ uid: CARD_UID, token: 'q3VbX9kLmN2pR7sT4wYz1A' }],
    ...o,
  };
}

function consumption(o: Row = {}): Row {
  return {
    id: 'c-1', tenantId: SALA, walletId: WALLET, amountCents: 3_000, tipCents: 0, category: 'VENUE_BAR',
    notes: 'Botella Moët', reversedAt: null, createdAt: at('2026-10-17T00:40:00Z'),
    providedBy: { email: 'lola@salabambu.es', displayName: 'Lola' },
    ...o,
  };
}

function makeService(rows: Row[]) {
  const matches = (r: Row, where: Row) => Object.entries(where).every(([k, v]) => r[k] === v);
  const clientWallet = {
    findMany: vi.fn(async (a: { where: Row; take: number }) => rows.filter((r) => matches(r, a.where)).slice(0, a.take)),
    findFirst: vi.fn(async (a: { where: Row }) => rows.find((r) => matches(r, a.where)) ?? null),
    findUnique: vi.fn(async (a: { where: Row }) => rows.find((r) => matches(r, a.where)) ?? null),
  };
  const tx = { clientWallet };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const svc = new WalletsService(prisma as never, { log: vi.fn() } as never);
  return { svc, clientWallet, prisma };
}

describe('lista de saldos del panel', () => {
  it('solo los del local que pregunta, sin el hash del PIN: lo que hay se dice con banderas', async () => {
    const { svc, clientWallet } = makeService([
      walletRow({ closeRequestedAt: at('2026-10-17T02:55:00Z'), pinLockedAt: at('2026-10-17T02:10:00Z') }),
      walletRow({ id: 'w-norte', tenantId: NORTE, shortCode: 'H8M2R5' }),
      walletRow({ id: 'w-sin-codigo', shortCode: null, pinHash: null, _count: { consumptions: 0, passkeys: 0, cards: 0 } }),
    ]);
    const list = await svc.listForAdmin({ tenantId: SALA });
    expect(list).toEqual([
      {
        id: WALLET, code: 'K7Q-4M2', closeRequestedAt: '2026-10-17T02:55:00.000Z', payoutPending: false, identifier: 'Mesa 4', balanceCents: 8_500,
        status: 'ACTIVE', expiresAt: null, consumptionCount: 3, createdAt: '2026-10-17T00:12:00.000Z',
        hasFaceId: true, hasPin: true, pinLocked: true, hasCard: true,
      },
      expect.objectContaining({ id: 'w-sin-codigo', code: null, hasFaceId: false, hasPin: false, pinLocked: false, hasCard: false }),
    ]);
    const json = JSON.stringify(list);
    for (const secret of [PIN_HASH, QR_TOKEN, CARD_UID, NORTE]) expect(json).not.toContain(secret);
    // Lo pide la base filtrado por el local, los más nuevos primero; las fichas cuentan solo las activas.
    expect(clientWallet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: SALA }, orderBy: { createdAt: 'desc' }, take: 50 }),
    );
    expect(clientWallet.findMany.mock.calls[0]![0]).toMatchObject({
      select: { _count: { select: { cards: { where: { status: { in: ['ISSUED', 'ACTIVE'] } } } } } },
    });
  });

  it('con filtro de estado y límite, los pasa tal cual a la consulta del local', async () => {
    const { svc, clientWallet } = makeService([
      walletRow({ id: 'w-1', status: 'REFUNDED' }),
      walletRow({ id: 'w-2', status: 'ACTIVE' }),
      walletRow({ id: 'w-3', status: 'REFUNDED' }),
    ]);
    const list = await svc.listForAdmin({ tenantId: SALA, status: 'REFUNDED', limit: 1 });
    expect(list.map((w) => [w.id, w.status])).toEqual([['w-1', 'REFUNDED']]);
    expect(clientWallet.findMany.mock.calls[0]![0]).toMatchObject({ where: { tenantId: SALA, status: 'REFUNDED' }, take: 1 });
  });
});

describe('ficha de un saldo en el panel', () => {
  it('con sus consumos (anulados incluidos) y quién los cobró; sin su enlace ni el hash del PIN', async () => {
    const { svc, clientWallet } = makeService([
      walletRow({
        consumptions: [
          consumption(),
          consumption({ id: 'c-2', category: 'CHICA_SERVICE', notes: 'Reservado 30 min\n[REVERSED: error]', reversedAt: at('2026-10-17T01:00:00Z'), providedBy: { email: 'nerea@salabambu.es', displayName: null } }),
        ],
      }),
    ]);
    const view = await svc.getWalletView({ tenantId: SALA, walletId: WALLET });
    expect(view).toEqual({
      id: WALLET, identifier: 'Mesa 4', balanceCents: 8_500, status: 'ACTIVE', expiresAt: null, createdAt: '2026-10-17T00:12:00.000Z',
      consumptions: [
        { id: 'c-1', amountCents: 3_000, category: 'VENUE_BAR', notes: 'Botella Moët', reversedAt: null, providedByEmail: 'lola@salabambu.es', providedByName: 'Lola', createdAt: '2026-10-17T00:40:00.000Z' },
        expect.objectContaining({ id: 'c-2', reversedAt: '2026-10-17T01:00:00.000Z', providedByEmail: 'nerea@salabambu.es', providedByName: null }),
      ],
    });
    const json = JSON.stringify(view);
    for (const secret of [PIN_HASH, QR_TOKEN, CARD_UID]) expect(json).not.toContain(secret);
    expect(clientWallet.findFirst.mock.calls[0]![0]).toMatchObject({ where: { id: WALLET, tenantId: SALA } });
  });

  it('un saldo de otro local (aunque sea del mismo grupo) no se ve desde aquí', async () => {
    const { svc } = makeService([walletRow({ tenantId: NORTE, consumptions: [] })]);
    await expect(svc.getWalletView({ tenantId: SALA, walletId: WALLET })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('vista pública del saldo (el enlace del cliente)', () => {
  it('solo saldo, estado y consumos no anulados; nada del PIN, la ficha, el local ni el personal', async () => {
    const { svc, clientWallet } = makeService([
      walletRow({
        expiresAt: at('2026-10-18T06:00:00Z'),
        consumptions: [
          consumption({ tenantId: NORTE }),
          consumption({ id: 'c-2', reversedAt: at('2026-10-17T01:00:00Z'), notes: 'Copa\n[REVERSED: cobrada dos veces]' }),
          consumption({ id: 'c-3', category: 'CHICA_SERVICE', amountCents: 10_000, notes: 'Reservado 60 min', providedBy: { email: 'carla@salabambu.es', displayName: 'Carla' } }),
        ],
      }),
    ]);
    const view = await svc.getPublicByToken(QR_TOKEN);
    expect(view).toEqual({
      id: WALLET, balanceCents: 8_500, status: 'ACTIVE', expiresAt: '2026-10-18T06:00:00.000Z',
      consumptions: [
        { id: 'c-1', amountCents: 3_000, category: 'VENUE_BAR', providedByName: 'Lola', createdAt: '2026-10-17T00:40:00.000Z' },
        { id: 'c-3', amountCents: 10_000, category: 'CHICA_SERVICE', providedByName: 'Carla', createdAt: '2026-10-17T00:40:00.000Z' },
      ],
    });
    const json = JSON.stringify(view);
    for (const secret of [PIN_HASH, QR_TOKEN, CARD_UID, SALA, NORTE, 'K7Q4M2', 'Mesa 4', '@salabambu.es', 'REVERSED', 'Moët']) {
      expect(json).not.toContain(secret);
    }
    // A la base solo se le pide el nombre de quien cobró (ni su email), por el enlace.
    const args = clientWallet.findUnique.mock.calls[0]![0] as {
      where: Row;
      include?: { consumptions?: { take?: number; include?: { providedBy?: unknown } } };
    };
    expect(args.where).toEqual({ qrToken: QR_TOKEN });
    expect(args.include?.consumptions?.take).toBe(50);
    expect(args.include?.consumptions?.include?.providedBy).toEqual({ select: { displayName: true } });
  });

  it('un enlace que no existe (o el viejo tras darle uno nuevo) → 404', async () => {
    const { svc } = makeService([walletRow({ consumptions: [] })]);
    await expect(svc.getPublicByToken('enlace-viejo-del-cliente')).rejects.toBeInstanceOf(NotFoundException);
  });
});
