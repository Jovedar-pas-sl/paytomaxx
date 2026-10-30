import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { fichaProof } from './ficha-qr';
import { ReceptionFichaService } from './reception-ficha.service';

const SECRET = 'secreto-de-cookies-de-prueba-0123456789';
const VENUE = '11111111-1111-4111-8111-111111111111';
const W1 = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
const CARD = 'ficha-token-0123456789abcdef';

const wallet = {
  id: W1,
  tenantId: VENUE,
  walletGroup: null,
  shortCode: 'K7Q4M2',
  status: 'ACTIVE',
  balanceCents: 5000,
  blockedAt: null,
  mergedIntoId: null,
  closeRequestedAt: null,
  pendingAssignAt: null,
};

type Actor = { userId: string; role: 'WAITER' | 'MANAGER' | 'OWNER' | 'OPERATOR'; tenantId: string };
const WAITER: Actor = { userId: 'u-rec', role: 'WAITER', tenantId: VENUE };

function make(o: { wallet?: Record<string, unknown> | null; issued?: boolean; canTopUp?: boolean; nfc?: boolean; pinFails?: boolean } = {}) {
  let cards = o.issued ? 1 : 0;
  const tx = {
    clientWallet: { findUnique: vi.fn(async () => (o.wallet === undefined ? wallet : o.wallet)) },
    venue: {
      findUnique: vi.fn(async (args: { select: Record<string, unknown> }) =>
        'paymentMethods' in args.select ? { paymentMethods: { nfc: o.nfc ?? true } } : { walletGroup: null },
      ),
    },
    user: { findFirst: vi.fn(async () => ({ id: 'u-rec', role: 'WAITER', post: null })) },
    walletCard: {
      findFirst: vi.fn(async () => (cards > 0 ? { number: 417, printedNumber: null } : null)),
    },
  };
  const prisma = {
    asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    acrossVenues: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const charges = {
    checkPinForPayout: vi.fn(async () => {
      if (o.pinFails) throw new UnprocessableEntityException('PIN incorrecto. Quedan 4 intentos');
    }),
  };
  const audit = { log: vi.fn(async () => undefined) };
  const config = { get: vi.fn(() => SECRET) };
  const service = new ReceptionFichaService(prisma as never, charges as never, audit as never, config as never);
  const attach = vi.fn(async () => {
    cards += 1;
    return 0;
  });
  return { service, tx, charges, audit, attach, canTopUp: o.canTopUp ?? true };
}

vi.mock('../venues/charge-rights', () => ({
  assertCanTopUp: vi.fn(async (_tx: unknown, _venue: string, person: { role: string }) => {
    if (person.role === 'OPERATOR') throw new ForbiddenException('Las recargas se hacen en recepción');
  }),
}));
vi.mock('../venues/venue-methods', () => ({
  assertVenueAcceptsMethods: vi.fn(async (tx: { venue: { findUnique: (a: unknown) => Promise<{ paymentMethods: { nfc: boolean } }> } }) => {
    const v = await tx.venue.findUnique({ select: { paymentMethods: true } });
    if (!v.paymentMethods.nfc) throw new ConflictException({ message: 'Este local no acepta ahora fichas NFC', code: 'PAYMENT_METHOD_DISABLED' });
  }),
}));
const attachCard = vi.fn(async () => 0);
vi.mock('../wallets/wallet-card-ops', () => ({
  ISSUED_CARD_STATUSES: ['ISSUED', 'ACTIVE'],
  attachCard: (...args: unknown[]) => attachCard(...(args as [])),
}));

const give = (s: ReceptionFichaService, input: Record<string, unknown>, actor: Actor = WAITER) =>
  s.give(actor, { walletId: W1, card: CARD, ...input } as never);

describe('ReceptionFichaService.give — la ficha del saldo cargado desde casa', () => {
  it('con el QR de su saldo: la ficha se une a ese saldo y queda en el registro (sin PIN)', async () => {
    attachCard.mockClear();
    const m = make();
    const out = await give(m.service, { proof: fichaProof(SECRET, W1), uid: '04:a1:b2:c3' });
    expect(attachCard).toHaveBeenCalledWith(expect.anything(), {
      walletId: W1,
      venueId: VENUE,
      card: CARD,
      uid: '04A1B2C3',
      by: { userId: 'u-rec' },
    });
    expect(m.charges.checkPinForPayout).not.toHaveBeenCalled();
    expect(m.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'wallet.card_linked', targetId: W1, payload: expect.objectContaining({ via: 'qr', where: 'reception' }) }),
    );
    expect(out).toMatchObject({ walletId: W1, code: 'K7Q-4M2', balanceCents: 5000, via: 'qr' });
  });

  it('con su código y su PIN (el de siempre, con su contador de fallos)', async () => {
    attachCard.mockClear();
    const m = make();
    await expect(give(m.service, { pin: '2468' })).resolves.toMatchObject({ via: 'pin' });
    expect(m.charges.checkPinForPayout).toHaveBeenCalledWith(WAITER, W1, '2468');
    const wrong = make({ pinFails: true });
    attachCard.mockClear();
    await expect(give(wrong.service, { pin: '1111' })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(attachCard).not.toHaveBeenCalled();
  });

  it('sin QR ni PIN: 422 FICHA_PROOF_REQUIRED (recepción); el encargado y el dueño, sin prueba', async () => {
    attachCard.mockClear();
    const err = await give(make().service, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ code: 'FICHA_PROOF_REQUIRED' });
    expect(attachCard).not.toHaveBeenCalled();
    for (const role of ['MANAGER', 'OWNER'] as const) {
      await expect(give(make().service, {}, { ...WAITER, role })).resolves.toMatchObject({ via: 'manager' });
    }
  });

  it('un QR que no es de este saldo: 422 FICHA_PROOF_WRONG', async () => {
    const err = await give(make().service, { proof: fichaProof(SECRET, '3b4c5d6e-7f8a-4b9c-8d1e-2f3a4b5c6d7e') }).catch((e: unknown) => e);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ code: 'FICHA_PROOF_WRONG' });
  });

  it('solo la primera ficha: con una ya dada, recepción no da otra (antes de gastar un intento de PIN)', async () => {
    const m = make({ issued: true });
    const err = await give(m.service, { pin: '2468' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toContain('ya tiene ficha (nº 417)');
    expect(m.charges.checkPinForPayout).not.toHaveBeenCalled();
  });

  it('los mismos permisos que recepción (la chica, no) y con «Fichas NFC» encendido', async () => {
    await expect(give(make().service, { proof: fichaProof(SECRET, W1) }, { ...WAITER, role: 'OPERATOR' })).rejects.toBeInstanceOf(ForbiddenException);
    const off = await give(make({ nfc: false }).service, { proof: fichaProof(SECRET, W1) }).catch((e: unknown) => e);
    expect((off as ConflictException).getResponse()).toMatchObject({ code: 'PAYMENT_METHOD_DISABLED' });
  });

  it('saldos que no: de otro local, sumado a otro, bloqueado, cerrado, pendiente de asignar o con «Me voy»', async () => {
    const proof = fichaProof(SECRET, W1);
    await expect(give(make({ wallet: null }).service, { proof })).rejects.toBeInstanceOf(NotFoundException);
    await expect(give(make({ wallet: { ...wallet, tenantId: 'otro-local' } }).service, { proof })).rejects.toBeInstanceOf(NotFoundException);
    for (const extra of [
      { mergedIntoId: 'otro' },
      { blockedAt: new Date() },
      { status: 'REFUNDED' },
      { pendingAssignAt: new Date() },
      { closeRequestedAt: new Date() },
    ]) {
      await expect(give(make({ wallet: { ...wallet, ...extra } }).service, { proof })).rejects.toBeInstanceOf(ConflictException);
    }
    // Un saldo gastado (a cero) sí: la ficha sirve para recargarlo y pagar luego.
    await expect(give(make({ wallet: { ...wallet, status: 'DEPLETED', balanceCents: 0 } }).service, { proof })).resolves.toMatchObject({ via: 'qr' });
  });

  it('una ficha que no es nuestra: 400', async () => {
    await expect(give(make().service, { card: 'x', proof: fichaProof(SECRET, W1) })).rejects.toBeInstanceOf(BadRequestException);
  });
});
