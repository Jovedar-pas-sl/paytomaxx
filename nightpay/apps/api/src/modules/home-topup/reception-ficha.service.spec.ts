import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { fichaProof } from './ficha-qr';
import { ReceptionFichaService } from './reception-ficha.service';

const SECRET = 'secreto-de-cookies-de-prueba-0123456789';
const VENUE = '11111111-1111-4111-8111-111111111111';
const W1 = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
const CARD = 'ficha-token-0123456789abcdef';
const LINK = { id: W1, qrToken: 'enlace-1' };

const wallet = {
  id: W1,
  tenantId: VENUE,
  qrToken: 'enlace-1',
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

const attachCardInTx = vi.fn(async () => 0);
vi.mock('../wallets/wallet-card-ops', () => ({
  ISSUED_CARD_STATUSES: ['ISSUED', 'ACTIVE'],
  attachCardInTx: (...args: unknown[]) => attachCardInTx(...(args as [])),
}));
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

function make(o: { wallet?: Record<string, unknown> | null; issued?: boolean; hadCard?: boolean; nfc?: boolean; pinFails?: boolean } = {}) {
  let issued = o.issued ?? false;
  attachCardInTx.mockReset();
  attachCardInTx.mockImplementation(async () => {
    issued = true;
    return 0;
  });
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: W1 }]),
    clientWallet: { findUnique: vi.fn(async () => (o.wallet === undefined ? wallet : o.wallet)) },
    venue: {
      findUnique: vi.fn(async (args: { select: Record<string, unknown> }) =>
        'paymentMethods' in args.select ? { paymentMethods: { nfc: o.nfc ?? true } } : { walletGroup: null },
      ),
    },
    walletCard: {
      findFirst: vi.fn(async () => (issued ? { number: 417, printedNumber: null } : null)),
      count: vi.fn(async () => (o.hadCard ? 1 : 0)),
    },
    walletCardEvent: { count: vi.fn(async () => (o.hadCard ? 2 : 0)) },
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
  return { service, tx, charges, audit };
}

const give = (s: ReceptionFichaService, input: Record<string, unknown>, actor: Actor = WAITER) =>
  s.give(actor, { walletId: W1, card: CARD, ...input } as never);

describe('ReceptionFichaService.give — la ficha del saldo cargado desde casa', () => {
  it('con el QR de su saldo: la ficha se une a ese saldo, con el saldo bloqueado, y queda en el registro (sin PIN)', async () => {
    const m = make();
    const out = await give(m.service, { proof: fichaProof(SECRET, LINK), uid: '04:a1:b2:c3' });
    expect(attachCardInTx).toHaveBeenCalledWith(expect.anything(), {
      walletId: W1,
      venueId: VENUE,
      card: CARD,
      uid: '04A1B2C3',
      by: { userId: 'u-rec' },
    });
    // FOR UPDATE del saldo antes de volver a mirar la regla y dar la ficha (dos a la vez: gana una).
    expect(m.tx.$queryRaw).toHaveBeenCalled();
    expect(m.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(attachCardInTx.mock.invocationCallOrder[0]!);
    expect(m.charges.checkPinForPayout).not.toHaveBeenCalled();
    expect(m.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'wallet.card_linked', targetId: W1, payload: expect.objectContaining({ via: 'qr', where: 'reception' }) }),
    );
    expect(out).toMatchObject({ walletId: W1, code: 'K7Q-4M2', balanceCents: 5000, via: 'qr', fichaNumber: 417 });
  });

  it('el QR de antes de un enlace nuevo del dueño (otro qrToken) ya no vale: 422 FICHA_PROOF_WRONG', async () => {
    const err = await give(make({ wallet: { ...wallet, qrToken: 'enlace-nuevo' } }).service, { proof: fichaProof(SECRET, LINK) }).catch(
      (e: unknown) => e,
    );
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ code: 'FICHA_PROOF_WRONG' });
    expect(attachCardInTx).not.toHaveBeenCalled();
  });

  it('con su código y su PIN (el de siempre, con su contador de fallos)', async () => {
    const m = make();
    await expect(give(m.service, { pin: '2468' })).resolves.toMatchObject({ via: 'pin' });
    expect(m.charges.checkPinForPayout).toHaveBeenCalledWith(WAITER, W1, '2468');
    const wrong = make({ pinFails: true });
    await expect(give(wrong.service, { pin: '1111' })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(attachCardInTx).not.toHaveBeenCalled();
  });

  it('sin QR ni PIN: 422 FICHA_PROOF_REQUIRED (recepción); el encargado y el dueño, sin prueba', async () => {
    const err = await give(make().service, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ code: 'FICHA_PROOF_REQUIRED' });
    expect(attachCardInTx).not.toHaveBeenCalled();
    for (const role of ['MANAGER', 'OWNER'] as const) {
      await expect(give(make().service, {}, { ...WAITER, role })).resolves.toMatchObject({ via: 'manager' });
    }
  });

  it('con una ficha dada ahora, nadie aquí (antes de gastar un intento de su PIN)', async () => {
    for (const actor of [WAITER, { ...WAITER, role: 'MANAGER' as const }]) {
      const m = make({ issued: true });
      const err = await give(m.service, { pin: '2468' }, actor).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as Error).message).toContain('ya tiene ficha (nº 417)');
      expect(m.charges.checkPinForPayout).not.toHaveBeenCalled();
    }
  });

  it('solo la primera: si ya tuvo una (perdida, bloqueada, sustituida), recepción no da otra ni con su QR; el encargado, sí', async () => {
    const m = make({ hadCard: true });
    const err = await give(m.service, { proof: fichaProof(SECRET, LINK) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toContain('ya tuvo ficha');
    expect(attachCardInTx).not.toHaveBeenCalled();
    await expect(give(make({ hadCard: true }).service, {}, { ...WAITER, role: 'MANAGER' })).resolves.toMatchObject({ via: 'manager' });
  });

  it('los mismos permisos que recepción (la chica, no) y con «Fichas NFC» encendido', async () => {
    await expect(give(make().service, { proof: fichaProof(SECRET, LINK) }, { ...WAITER, role: 'OPERATOR' })).rejects.toBeInstanceOf(ForbiddenException);
    const off = await give(make({ nfc: false }).service, { proof: fichaProof(SECRET, LINK) }).catch((e: unknown) => e);
    expect((off as ConflictException).getResponse()).toMatchObject({ code: 'PAYMENT_METHOD_DISABLED' });
  });

  it('saldos que no: de otro local, sumado a otro, bloqueado, cerrado, pendiente de asignar o con «Me voy»', async () => {
    const proof = fichaProof(SECRET, LINK);
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
    await expect(give(make().service, { card: 'x', proof: fichaProof(SECRET, LINK) })).rejects.toBeInstanceOf(BadRequestException);
  });
});
