import { describe, it, expect, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { GATEWAY_ERROR_PUBLIC, PaymentsService } from './payments.service';
import { payErrorKey } from './pay-i18n';

/** POST /payments/public/:token/start-authorization es público: sin detalles de la pasarela (#59). */
function makeService(authorizeError: Error) {
  const db = {
    payment: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'pay-1',
        tenantId: 'tenant-1',
        amountCents: 1_000,
        tipCents: 0,
        currency: 'EUR',
        qrExpiresAt: new Date(Date.now() + 60_000),
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    gatewayCredential: { findFirst: vi.fn().mockResolvedValue({ provider: 'PAYTEF' }) },
    venue: { findUnique: vi.fn().mockResolvedValue({ pausedAt: null, business: null, paymentMethods: null }) },
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = Object.create(PaymentsService.prototype) as PaymentsService;
  const transition = vi.fn().mockResolvedValue(undefined);
  Object.assign(service, {
    prisma: { asSystem: vi.fn(async (fn: (t: typeof db) => unknown) => fn(db)) },
    gateways: { get: () => ({ authorize: vi.fn().mockRejectedValue(authorizeError) }) },
    logger,
    transition,
  });
  return { service, logger, transition };
}

describe('startAuthorization — error de la pasarela', () => {
  const leaky = new Error('Paytef 400: sent: {"amount":1000,"terminal":"T1","key":"abc"} branchesRaw: [..]');

  it('al cliente, un mensaje genérico; el detalle, solo al log', async () => {
    const { service, logger, transition } = makeService(leaky);
    const err = await service.startAuthorization('qr-token').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toBe(GATEWAY_ERROR_PUBLIC);
    expect((err as Error).message).not.toMatch(/sent:|branchesRaw|Paytef/);
    expect(logger.error.mock.calls[0]![0]).toContain('branchesRaw');
    // El cobro queda FAILED como antes (saga).
    expect(transition).toHaveBeenCalledWith('pay-1', { type: 'FAILED', reason: 'gateway-authorize-error' });
  });

  it('la página /pay lo sigue mostrando como "el banco no responde"', () => {
    expect(payErrorKey(GATEWAY_ERROR_PUBLIC)).toBe('gateway');
  });
});

describe('findById — detalle del cobro para el personal', () => {
  it('nunca incluye el token de la tarjeta (#60)', async () => {
    const service = Object.create(PaymentsService.prototype) as PaymentsService;
    const row = { id: 'pay-1', amountCents: 1_000, provider: 'REDSYS', tokenizationData: { identifier: 'tok' } };
    Object.assign(service, { prisma: { payment: { findUnique: vi.fn().mockResolvedValue(row) } } });
    const out = await service.findById('pay-1');
    expect(out).toEqual({ id: 'pay-1', amountCents: 1_000, provider: 'REDSYS' });
    expect(out).not.toHaveProperty('tokenizationData');
  });
});
