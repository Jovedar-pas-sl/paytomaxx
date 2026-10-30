import { describe, expect, it, vi } from 'vitest';
import { PayStatusService, RESULT_PAGE_PROVIDERS, isPayLookupKey } from './pay-status.service';

const NOW = new Date('2026-10-17T01:30:00+02:00');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

/** Un cobro en el banco (lo que devuelve el `select` del servicio). */
function paymentRow(o: Record<string, unknown> = {}) {
  return {
    status: 'AUTHORIZING',
    provider: 'REDSYS',
    amountCents: 3_300,
    serviceFeeCents: 330,
    tipCents: 200,
    currency: 'EUR',
    qrToken: '6f1c2a54-3b1e-4c55-9f7e-2d6a1b0c9e11',
    qrExpiresAt: new Date(NOW.getTime() + 10 * 60_000),
    updatedAt: ago(30),
    ref: 12,
    serviceName: 'Gin tonic',
    venue: { name: 'Sala Aurora', paymentMethods: null },
    attempts: [{ providerTxId: '9829cKpMwwBX', status: 'PENDING', createdAt: ago(30), claimHash: 'huella-a', amountCents: 3_830 }],
    linkedWalletCharge: null,
    ...o,
  };
}

function serviceWith(opts: { attempt?: { paymentId: string } | null; payment?: Record<string, unknown> | null } = {}) {
  const tx = {
    paymentAttempt: { findFirst: vi.fn(async () => (opts.attempt === undefined ? { paymentId: 'p-1' } : opts.attempt)) },
    payment: {
      findFirst: vi.fn(async () => (opts.payment === undefined ? paymentRow() : opts.payment)),
      findUnique: vi.fn(async () => (opts.payment === undefined ? paymentRow() : opts.payment)),
    },
  };
  const prisma = { asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { service: new PayStatusService(prisma as never), prisma, tx };
}

describe('«Comprobando el pago»: buscar el cobro sin abrir la puerta a cualquier cosa (rutas públicas)', () => {
  it('un token o un pedido con buena pinta: UUID, Ds_Order de Redsys (12) y Num_operacion de Cecabank (32)', () => {
    for (const ok of ['6f1c2a54-3b1e-4c55-9f7e-2d6a1b0c9e11', '9829cKpMwwBX', 'a'.repeat(32)]) expect(isPayLookupKey(ok)).toBe(true);
    for (const bad of [undefined, null, '', 'abc', 'a'.repeat(65), 'con espacio', 'nul\u0000x', '../etc', ['9829cKpMwwBX', 'x'], 42]) {
      expect(isPayLookupKey(bad)).toBe(false);
    }
  });

  it('por el pedido del banco: con uno raro (una lista por ?op=a&op=b, vacío, un NUL), «no encontrado» sin tocar la base de datos', async () => {
    const { service, prisma } = serviceWith();
    for (const bad of [['9829cKpMwwBX', 'otro'], '', undefined, 'nul\u0000x', 'x'.repeat(200)]) {
      await expect(service.byOrder(bad, NOW)).resolves.toBeNull();
    }
    expect(prisma.asSystem).not.toHaveBeenCalled();
  });

  it('por el pedido del banco: solo entre las pasarelas que vuelven a /pay/result (por el índice único provider + pedido)', async () => {
    const { service, tx } = serviceWith();
    const ctx = await service.byOrder('9829cKpMwwBX', NOW);
    expect(ctx?.view).toMatchObject({ state: 'processing', venueName: 'Sala Aurora', otherPayer: false });
    expect(tx.paymentAttempt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { provider: { in: [...RESULT_PAGE_PROVIDERS] }, providerTxId: '9829cKpMwwBX' } }),
    );
    expect(tx.payment.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p-1' } }));
  });

  it('un cobro de antes de los intentos: por el pedido del cobro, también solo de esas pasarelas', async () => {
    const { service, tx } = serviceWith({ attempt: null });
    await service.byOrder('9829cKpMwwBX', NOW);
    expect(tx.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { provider: { in: ['REDSYS', 'WIPAY'] }, providerTxId: '9829cKpMwwBX' } }),
    );
  });

  it('por el pedido: el estado de ESE intento (denegado aunque el cobro siga en el banco); desconocido, null', async () => {
    const denied = serviceWith({
      payment: paymentRow({ attempts: [{ providerTxId: '9829cKpMwwBX', status: 'DENIED', createdAt: ago(20), claimHash: 'huella-a', amountCents: 3_830 }] }),
    });
    await expect(denied.service.byOrder('9829cKpMwwBX', NOW)).resolves.toMatchObject({ view: { state: 'denied' } });
    const none = serviceWith({ attempt: null, payment: null });
    await expect(none.service.byOrder('desconocido1', NOW)).resolves.toBeNull();
  });

  it('por el QR: con un token raro, null sin tocar la base de datos; con uno bueno, el estado con «otro está pagando»', async () => {
    const { service, prisma, tx } = serviceWith();
    await expect(service.byToken('nul\u0000x', null, NOW)).resolves.toBeNull();
    expect(prisma.asSystem).not.toHaveBeenCalled();
    const ctx = await service.byToken('6f1c2a54-3b1e-4c55-9f7e-2d6a1b0c9e11', 'huella-b', NOW);
    expect(tx.payment.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { qrToken: '6f1c2a54-3b1e-4c55-9f7e-2d6a1b0c9e11' } }));
    expect(ctx).toMatchObject({ view: { state: 'processing', otherPayer: true }, ref: 'C-0012', concept: 'Gin tonic' });
  });
});
