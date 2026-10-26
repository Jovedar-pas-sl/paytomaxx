import { describe, it, expect, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import {
  GATEWAY_ERROR_PUBLIC,
  GATEWAY_FAILED_AFTER_ATTEMPT_PUBLIC,
  GATEWAY_FAILED_PUBLIC,
  PaymentsService,
} from './payments.service';
import { payErrorKey, payErrorKeyOf } from './pay-i18n';
import { GatewayTransientError } from '../gateways/gateway-errors';

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
        status: 'CREATED',
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
    expect((err as Error).message).toBe(GATEWAY_FAILED_PUBLIC);
    expect(JSON.stringify((err as ConflictException).getResponse())).not.toMatch(/sent:|branchesRaw|Paytef/);
    expect(logger.error.mock.calls[0]![0]).toContain('branchesRaw');
    // Un 400 de Paytef no se arregla repitiendo: el cobro queda FAILED (nunca llegó al banco).
    expect(transition).toHaveBeenCalledWith('pay-1', { type: 'CHECKOUT_FAILED', reason: 'gateway-authorize-error' });
  });

  it('fallo pasajero: el mismo mensaje genérico, con reintento, y el cobro sin tocar', async () => {
    const { service, transition } = makeService(new GatewayTransientError('Paytef /save sin respuesta: sent: {"key":"abc"}'));
    const err = await service.startAuthorization('qr-token').catch((e: unknown) => e);
    expect((err as Error).message).toBe(GATEWAY_ERROR_PUBLIC);
    expect(JSON.stringify((err as ConflictException).getResponse())).not.toMatch(/sent:|abc/);
    expect(transition).not.toHaveBeenCalled();
  });
});

describe('qué página de /pay enseña cada error de la pasarela', () => {
  it('pasajero (GATEWAY_RETRY) → «el banco no responde», con «Intentar otra vez»', () => {
    expect(payErrorKey(GATEWAY_ERROR_PUBLIC)).toBe('gateway');
    expect(payErrorKeyOf(new ConflictException({ message: GATEWAY_ERROR_PUBLIC, code: 'GATEWAY_RETRY' }))).toBe('gateway');
  });

  it('definitivo (GATEWAY_FAILED) → no se pudo abrir: pedir otro cobro, sin reintentar', () => {
    expect(payErrorKeyOf(new ConflictException({ message: GATEWAY_FAILED_PUBLIC, code: 'GATEWAY_FAILED' }))).toBe(
      'gatewayFailed',
    );
  });

  it('definitivo con un intento anterior en el banco → sin reintentar y sin decir que no se cobró', () => {
    const err = new ConflictException({ message: GATEWAY_FAILED_AFTER_ATTEMPT_PUBLIC, code: 'GATEWAY_FAILED_AFTER_ATTEMPT' });
    expect(payErrorKeyOf(err)).toBe('gatewayFailedAfterAttempt');
  });

  it('sin código conocido, por el texto como antes', () => {
    expect(payErrorKeyOf(new ConflictException('QR expired'))).toBe('expired');
    expect(payErrorKeyOf(new ConflictException('Payment cannot start authorization (already in progress?)'))).toBe(
      'inProgress',
    );
    expect(payErrorKeyOf(new Error('Connection terminated'))).toBe('generic');
    expect(payErrorKeyOf(new ConflictException({ message: 'x', code: 'OTRO' }))).toBe('generic');
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
