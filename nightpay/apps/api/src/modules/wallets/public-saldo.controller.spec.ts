import { describe, expect, it, vi } from 'vitest';
import { PublicSaldoController } from './public-saldo.controller';

describe('/s/:token/state: la página pregunta si el cobro sigue pendiente tras un fallo que no se sabe si cobró', () => {
  it('pagado: el estado y su código (el mismo que ya sale en la página del cobro pagado); nada de importes ni saldo', async () => {
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
    const controller = new PublicSaldoController(charges as never, {} as never, {} as never);
    await expect(controller.state('tok-1')).resolves.toEqual({ status: 'ACCEPTED', code: 'Z9Q' });
    expect(charges.qrChargeForClient).toHaveBeenCalledWith('tok-1');
  });

  it('antes de pagarse, solo el estado: el código nunca sale (un «Pagado» falso no lo tendría)', async () => {
    const charges = { qrChargeForClient: vi.fn(async () => ({ status: 'PENDING', amountCents: 6000, code: 'Z9Q' })) };
    const controller = new PublicSaldoController(charges as never, {} as never, {} as never);
    await expect(controller.state('tok-1')).resolves.toEqual({ status: 'PENDING' });
  });

  it('pagado con tarjeta (cobro único): el estado que ve la página al recargar (CANCELED)', async () => {
    const charges = { qrChargeForClient: vi.fn(async () => ({ status: 'CANCELED', paidElsewhere: true })) };
    const controller = new PublicSaldoController(charges as never, {} as never, {} as never);
    await expect(controller.state('tok-1')).resolves.toEqual({ status: 'CANCELED' });
  });
});

describe('/s/:token/pay: tras pagar con su llave, «Ver mi saldo» lleva a SU saldo', () => {
  const SECRET = 'test-only-cookie-secret-with-32-characters';
  const paid = { amountCents: 6000, balanceCents: 4000, code: 'Z9Q' };

  it('el enlace de su saldo y la sesión de consulta (la llave ya se comprobó al pagar)', async () => {
    const charges = {
      payQrCharge: vi.fn(async () => paid),
      liveWalletRef: vi.fn(async () => ({ id: 'w-1', qrToken: 'privateWalletToken0123456' })),
    };
    const passkeys = { verify: vi.fn(async () => 'w-1') };
    const res = { header: vi.fn() };
    const controller = new PublicSaldoController(charges as never, passkeys as never, { get: () => SECRET } as never);
    await expect(controller.pay('tok-1', { response: { id: 'k' } }, 'api.test', res as never)).resolves.toEqual({
      ...paid,
      walletUrl: '/w/privateWalletToken0123456',
    });
    expect(charges.payQrCharge).toHaveBeenCalledWith('tok-1', 'w-1');
    expect(res.header).toHaveBeenCalledWith('Set-Cookie', expect.arrayContaining([expect.stringContaining('Path=/w/privateWalletToken0123456')]));
  });

  it('si no se encuentra el saldo, el pago sigue igual (sin enlace ni cookie)', async () => {
    const charges = { payQrCharge: vi.fn(async () => paid), liveWalletRef: vi.fn(async () => null) };
    const res = { header: vi.fn() };
    const controller = new PublicSaldoController(charges as never, { verify: async () => 'w-1' } as never, { get: () => SECRET } as never);
    await expect(controller.pay('tok-1', { response: {} }, 'api.test', res as never)).resolves.toEqual(paid);
    expect(res.header).not.toHaveBeenCalled();
  });
});
