import { describe, it, expect, vi } from 'vitest';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { WebhooksController } from './webhooks.controller';
import type { WebhookProviderGate } from './webhook-provider-gate';

// Paytef y Peanpe que ningún local usa: sus rutas de avisos contestan 404 sin
// procesar nada. Redsys y Wipay no pasan por la puerta.

function makeHarness(inUse: ReadonlyArray<'PAYTEF' | 'PEANPE'>) {
  const gate = { enabled: vi.fn(async (p: 'PAYTEF' | 'PEANPE') => inUse.includes(p)) };
  const prisma = {
    asSystem: vi.fn(),
    webhookDelivery: { findUnique: vi.fn(), create: vi.fn() },
  };
  const gateways = { get: vi.fn(() => ({ verifyWebhook: vi.fn(() => ({ valid: false, reason: 'x' })) })) };
  const queue = { add: vi.fn(), getJob: vi.fn() };
  const metrics = { webhooksReceived: { inc: vi.fn() }, duplicateCharges: { inc: vi.fn() } };
  const config = { get: vi.fn((k: string) => (k === 'PAYTEF_WEBHOOK_SECRET' ? 'el-secreto-de-paytef' : undefined)) };
  const redis = { eval: vi.fn().mockResolvedValue(1) };
  const peanpe = {
    getSecurityTokenForCall: vi.fn(),
    resolvePaymentFromCallback: vi.fn().mockResolvedValue(null),
    verifyWebhook: vi.fn(),
    persistCallbackResult: vi.fn(),
  };
  const redsys = { verifyWebhook: vi.fn(() => ({ valid: false, reason: 'firma' })) };
  const controller = new WebhooksController(
    prisma as never,
    gateways as never,
    queue as never,
    metrics as never,
    config as never,
    redis as never,
    peanpe as never,
    {} as never,
    redsys as never,
    gate as unknown as WebhookProviderGate,
  );
  /** Nada procesado: ni secreto, ni pasarela, ni Redis, ni base, ni cola, ni métricas. */
  const untouched = () => {
    expect(config.get).not.toHaveBeenCalled();
    expect(gateways.get).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
    expect(peanpe.getSecurityTokenForCall).not.toHaveBeenCalled();
    expect(peanpe.resolvePaymentFromCallback).not.toHaveBeenCalled();
    expect(prisma.webhookDelivery.findUnique).not.toHaveBeenCalled();
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(metrics.webhooksReceived.inc).not.toHaveBeenCalled();
  };
  return { controller, gate, config, redis, peanpe, redsys, untouched };
}

const paytefRequest = { headers: {}, body: { paymentID: 'PL-1' } } as unknown as FastifyRequest;
const peanpeChallenge = { headers: {}, body: { identificador_llamada: 'K7MZ4Q' } } as unknown as FastifyRequest;

describe('avisos de una pasarela que ningún local usa → 404 sin procesar nada', () => {
  it('Paytef (URL secreta): 404 aunque el secreto sea el bueno', async () => {
    const h = makeHarness(['PEANPE']);
    await expect(h.controller.receivePaytef('el-secreto-de-paytef', paytefRequest)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.gate.enabled).toHaveBeenCalledWith('PAYTEF');
    h.untouched();
  });

  it('Peanpe, reto (POST) y resultado (GET): 404 sin tocar el límite de Redis ni dar un token', async () => {
    const h = makeHarness(['PAYTEF']);
    await expect(h.controller.peanpeChallenge(peanpeChallenge)).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.controller.peanpeResult('K7MZ4Q', '4829105736', '200', 'OK', undefined, undefined)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // Ni siquiera valida los parámetros: la ruta no existe.
    await expect(h.controller.peanpeResult(undefined, undefined, undefined, undefined, undefined, undefined)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.gate.enabled).toHaveBeenCalledWith('PEANPE');
    h.untouched();
  });
});

describe('con algún local usándola, como siempre', () => {
  it('Paytef en uso: pasa la puerta y se comprueba el secreto (malo → 401)', async () => {
    const h = makeHarness(['PAYTEF']);
    await expect(h.controller.receivePaytef('otro-secreto', paytefRequest)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.config.get).toHaveBeenCalledWith('PAYTEF_WEBHOOK_SECRET');
  });

  it('Peanpe en uso: el reto cuenta el intento y busca el token (desconocido → 401)', async () => {
    const h = makeHarness(['PEANPE']);
    await expect(h.controller.peanpeChallenge(peanpeChallenge)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.redis.eval).toHaveBeenCalled();
    expect(h.peanpe.getSecurityTokenForCall).toHaveBeenCalledWith('K7MZ4Q');
  });

  it('Redsys no pasa por la puerta: con Paytef y Peanpe cerrados se atiende igual', async () => {
    const h = makeHarness([]);
    const notice = { headers: {}, body: { Ds_SignatureVersion: 'HMAC_SHA256_V1', Ds_MerchantParameters: 'e30=', Ds_Signature: 'x' } };
    await expect(h.controller.receiveRedsys(notice as unknown as FastifyRequest)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.redsys.verifyWebhook).toHaveBeenCalled();
    expect(h.gate.enabled).not.toHaveBeenCalled();
  });
});
