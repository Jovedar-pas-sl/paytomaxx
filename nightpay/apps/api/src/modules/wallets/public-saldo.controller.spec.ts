import { describe, expect, it, vi } from 'vitest';
import { PublicSaldoController } from './public-saldo.controller';

describe('/s/:token/state: la página pregunta si el cobro sigue pendiente tras un fallo que no se sabe si cobró', () => {
  it('solo el estado (sin importes, saldo ni código del cobro)', async () => {
    const charges = {
      qrChargeForClient: vi.fn(async () => ({
        status: 'ACCEPTED',
        amountCents: 6000,
        serviceName: 'Masaje',
        venueName: 'Luna',
        requestedByName: 'Lola',
        expiresAt: '2026-10-15T22:05:00.000Z',
        paidAt: '2026-10-15T22:01:00.000Z',
        code: 'Z9Q',
      })),
    };
    const controller = new PublicSaldoController(charges as never, {} as never);
    await expect(controller.state('tok-1')).resolves.toEqual({ status: 'ACCEPTED' });
    expect(charges.qrChargeForClient).toHaveBeenCalledWith('tok-1');
  });

  it('pagado con tarjeta (cobro único): el estado que ve la página al recargar (CANCELED)', async () => {
    const charges = { qrChargeForClient: vi.fn(async () => ({ status: 'CANCELED', paidElsewhere: true })) };
    const controller = new PublicSaldoController(charges as never, {} as never);
    await expect(controller.state('tok-1')).resolves.toEqual({ status: 'CANCELED' });
  });
});
