import { describe, expect, it, vi } from 'vitest';
import { FichaNumbersService } from './ficha-numbers.service';
import { printedLookupScopes, printedScopeOf } from './ficha-numbers';

const SALA = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a01';
const NORTE = '3f2b8c1e-6a4d-4f7e-9b21-5c8d0e1f2a02';
const actor = { userId: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d03', role: 'WAITER' as 'WAITER' | 'OPERATOR', tenantId: SALA };

type Row = Record<string, unknown>;

function setup(o: { cards?: Row[]; wallet?: Row | null; post?: string; nfc?: boolean; recent?: boolean } = {}) {
  const cards = o.cards ?? [{ id: 'c-1', walletId: 'w-1', status: 'ISSUED', venueId: SALA, printedNumberNorm: '17', printedScope: 'g:grupo' }];
  const wallet = o.wallet === undefined
    ? { id: 'w-1', tenantId: NORTE, walletGroup: 'grupo', shortCode: 'K7Q4M2', balanceCents: 8_000, status: 'ACTIVE', pinHash: 'h', blockedAt: null, closeRequestedAt: null, mergedIntoId: null }
    : o.wallet;
  const venues: Record<string, Row> = { [SALA]: { id: SALA, walletGroup: 'grupo', paymentMethods: o.nfc === false ? { nfc: false } : null, postRules: null, sections: null }, [NORTE]: { id: NORTE, walletGroup: 'grupo' } };
  const tx = {
    user: {
      findFirst: vi.fn(async () => ({ post: o.post ?? 'RECEPCION' })),
      findUnique: vi.fn(async () => ({ displayName: 'Sergio García', email: 'sergio@local.es' })),
    },
    // La última recarga (A4): una en efectivo hace un momento, de Sergio.
    walletCashTopUp: { findFirst: vi.fn(async () => (o.recent ? { createdAt: new Date(), amountCents: 5_000, takenByUserId: 'u-sergio' } : null)) },
    payment: { findFirst: vi.fn(async () => null) },
    venue: { findUnique: vi.fn(async (a: { where: { id: string } }) => venues[a.where.id] ?? null) },
    walletCard: {
      findMany: vi.fn(async (a: { where: { printedNumberNorm: string; printedScope: { in: string[] } } }) =>
        cards.filter((c) => c.printedNumberNorm === a.where.printedNumberNorm && a.where.printedScope.in.includes(String(c.printedScope)))),
    },
    clientWallet: { findUnique: vi.fn(async () => wallet) },
    $queryRaw: vi.fn(async () => [{ inCents: 5_000n, inWindowCents: 5_000n, outCents: 0n, outWindowCents: 0n }]),
  };
  const run = async (fn: (t: typeof tx) => unknown) => fn(tx);
  const prisma = { venue: tx.venue, asSystem: vi.fn(run), acrossVenues: vi.fn(run) };
  const audit = { log: vi.fn(async () => undefined) };
  const cash = { topUp: vi.fn(async () => ({ topUpId: 't-1', walletId: 'w-1', code: 'K7Q-4M2', amountCents: 2_000, balanceCents: 10_000, createdWallet: false, replayed: false })) };
  const svc = new FichaNumbersService(prisma as never, audit as never, cash as never);
  return { svc, audit, cash, tx };
}

describe('buscar una ficha por su número impreso (sin acercarla)', () => {
  it('sin los ceros de delante y en su grupo: solo el estado, el código tapado y los importes', async () => {
    const { svc, audit } = setup();
    const view = await svc.lookup(actor, '00017');
    expect(view).toEqual({
      // En efectivo no sale nada: el saldo no se devuelve (una app de antes no enseña «Devolver»).
      kind: 'saldo', printedNumber: '00017', codeHint: 'K7Q-•••', balanceCents: 8_000, cashOutCents: 0,
      cashOutNote: 'El saldo no se devuelve: se queda para la próxima visita.', hasPin: true, blocked: false, closeRequested: false, isHomeVenue: false,
      lastTopUp: null,
    });
    expect(JSON.stringify(view)).not.toMatch(/w-1|K7Q-4M2|K7Q4M2|c-1/);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'wallet.card_number_lookup', actorId: actor.userId, targetId: 'c-1', payload: { printedNumber: '00017', result: 'saldo' } }));
  });

  it('con la última recarga si es reciente (A4): el nombre de pila, nunca el email', async () => {
    const { svc } = setup({ recent: true });
    const view = await svc.lookup(actor, '17');
    expect(view.kind === 'saldo' ? view.lastTopUp : null).toMatchObject({ amountCents: 5_000, method: 'cash', byName: 'Sergio' });
    expect(JSON.stringify(view)).not.toContain('@');
  });

  it('del stock (o de un saldo cerrado): «nueva», sin nada más; cada búsqueda queda en el registro', async () => {
    const stock = setup({ cards: [{ id: 'c-2', walletId: null, status: 'STOCK', venueId: SALA, printedNumberNorm: '17', printedScope: `v:${SALA}` }] });
    await expect(stock.svc.lookup(actor, '17')).resolves.toEqual({ kind: 'new', printedNumber: '17' });
    const closed = setup({ wallet: { id: 'w-1', tenantId: SALA, walletGroup: 'grupo', status: 'REFUNDED', balanceCents: 0, mergedIntoId: null } });
    await expect(closed.svc.lookup(actor, '17')).resolves.toEqual({ kind: 'new', printedNumber: '17' });
    const none = setup({ cards: [] });
    await expect(none.svc.lookup(actor, '17')).rejects.toMatchObject({ status: 404 });
    expect(none.audit.log).toHaveBeenCalledWith(expect.objectContaining({ payload: { printedNumber: '17', result: 'not_found' } }));
  });

  it('dos fichas con el mismo número: que la acerque; bloqueada: no; de otro grupo: no la ve', async () => {
    const two = setup({ cards: [
      { id: 'a', walletId: null, status: 'STOCK', venueId: SALA, printedNumberNorm: '17', printedScope: 'g:grupo' },
      { id: 'b', walletId: null, status: 'STOCK', venueId: SALA, printedNumberNorm: '17', printedScope: `v:${SALA}` },
    ] });
    await expect(two.svc.lookup(actor, '17')).rejects.toThrow(/acércala/);
    const blocked = setup({ cards: [{ id: 'a', walletId: null, status: 'BLOCKED', venueId: SALA, printedNumberNorm: '17', printedScope: 'g:grupo' }] });
    await expect(blocked.svc.lookup(actor, '17')).rejects.toMatchObject({ status: 409 });
    const foreign = setup({ cards: [{ id: 'a', walletId: null, status: 'STOCK', venueId: SALA, printedNumberNorm: '17', printedScope: 'g:otro' }] });
    await expect(foreign.svc.lookup(actor, '17')).rejects.toMatchObject({ status: 404 });
  });

  it('solo recepción, con las fichas NFC encendidas', async () => {
    await expect(setup({ post: 'BARRA' }).svc.lookup(actor, '17')).rejects.toMatchObject({ status: 403 });
    await expect(setup({ nfc: false }).svc.lookup(actor, '17')).rejects.toMatchObject({ status: 409 });
    await expect(setup().svc.lookup(actor, '1x')).rejects.toMatchObject({ status: 400 });
  });
});

describe('recargar por número', () => {
  it('un saldo que ya existe: en efectivo, por la ficha encontrada, y sin enseñar su código', async () => {
    const { svc, cash } = setup();
    await expect(svc.topUp(actor, { printedNumber: '017', amountCents: 2_000, idempotencyKey: 'rec-12345678' })).resolves.toEqual({
      topUpId: 't-1', codeHint: 'K7Q-•••', amountCents: 2_000, serviceFeeCents: 0, balanceCents: 10_000, replayed: false,
    });
    expect(cash.topUp).toHaveBeenCalledWith(SALA, { userId: actor.userId, role: 'WAITER' }, { amountCents: 2_000, idempotencyKey: 'rec-12345678', wallet: { printed: { cardId: 'c-1' } } });
  });

  it('una ficha nueva (del stock) no se carga por número: «Para cargar una ficha nueva, acércala»', async () => {
    const { svc, cash } = setup({ cards: [{ id: 'c-2', walletId: null, status: 'STOCK', venueId: SALA, printedNumberNorm: '17', printedScope: 'g:grupo' }] });
    await expect(svc.topUp(actor, { printedNumber: '17', amountCents: 2_000, idempotencyKey: 'rec-12345678' })).rejects.toMatchObject({
      response: { message: 'Para cargar una ficha nueva, acércala', code: 'NEW_FICHA_NEEDS_TAP' },
    });
    expect(cash.topUp).not.toHaveBeenCalled();
  });
});

describe('el sitio del número', () => {
  it('el grupo si lo hay; si no, el local; se busca en los dos', () => {
    expect(printedScopeOf({ id: SALA, walletGroup: 'grupo' })).toBe('g:grupo');
    expect(printedScopeOf({ id: SALA, walletGroup: null })).toBe(`v:${SALA}`);
    expect(printedLookupScopes({ id: SALA, walletGroup: 'grupo' })).toEqual(['g:grupo', `v:${SALA}`]);
  });
});
