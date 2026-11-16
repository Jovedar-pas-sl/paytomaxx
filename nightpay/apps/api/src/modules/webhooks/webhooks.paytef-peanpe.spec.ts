import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { WebhooksController } from './webhooks.controller';
import { PaytefAdapter } from '../gateways/paytef.adapter';
import { PeanpeAdapter } from '../gateways/peanpe.adapter';

// Cobro de "Sala Apolo" (Barcelona) — ids con forma de UUID.
const PAYMENT_ID = '3f6c1d2e-8a4b-4c5d-9e7f-0a1b2c3d4e5f';
const TENANT_ID = 'b2c4e6f8-1a3c-4e5a-8b7c-9d0e1f2a3b4c';
const PAYTEF_SECRET = 'pt-9f8e7d6c5b4a39281706f5e4d3c2b1a0';
const ID_LLAMADA = 'K7MZ4Q';
const TOKEN = '4829105736';
const NOW = new Date('2026-10-17T02:15:00Z');

interface Options {
  /** null = sin configurar. */
  paytefSecret?: string | null;
  existing?: { id: bigint; processedAt: Date | null } | null;
  attempts?: number | string;
  peanpeCall?: { paymentId: string; tenantId: string; securityToken: string } | null;
}

function makeHarness(o: Options = {}) {
  const metrics = {
    webhooksReceived: { inc: vi.fn() },
    duplicateCharges: { inc: vi.fn() },
    gatewayDuration: { observe: vi.fn() },
    circuitState: { set: vi.fn() },
  };
  const config = {
    get: vi.fn((key: string) => {
      if (key === 'PAYTEF_WEBHOOK_SECRET') return o.paytefSecret === undefined ? PAYTEF_SECRET : (o.paytefSecret ?? undefined);
      if (key === 'GATEWAY_TIMEOUT_MS') return 5000;
      return undefined;
    }),
  };
  const call =
    o.peanpeCall === undefined ? { paymentId: PAYMENT_ID, tenantId: TENANT_ID, securityToken: TOKEN } : o.peanpeCall;
  const tx = {
    peanpeCall: { findUnique: vi.fn().mockResolvedValue(call), update: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    webhookDelivery: {
      findUnique: vi.fn().mockResolvedValue(o.existing ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: BigInt(314),
        processedAt: null,
        ...data,
      })),
    },
  };
  const paytef = new PaytefAdapter(config as never, metrics as never);
  const peanpe = new PeanpeAdapter(config as never, metrics as never, prisma as never);
  const gateways = {
    get: vi.fn((p: string) => {
      if (p === 'PAYTEF') return paytef;
      throw new Error(`No gateway adapter for provider=${p}`);
    }),
  };
  const queue = { add: vi.fn().mockResolvedValue(undefined), getJob: vi.fn().mockResolvedValue(undefined) };
  const redis = { eval: vi.fn().mockResolvedValue(o.attempts ?? 1) };
  // Wipay y Redsys no intervienen en estas rutas.
  const controller = new WebhooksController(
    prisma as never, gateways as never, queue as never, metrics as never,
    config as never, redis as never, peanpe, {} as never, {} as never,
  );
  return { controller, prisma, tx, paytef, peanpe, gateways, queue, redis, metrics, config };
}

/** Aviso de Paytef (notifyResultURL) de un link pagado. */
const PAYTEF_BODY = {
  paymentID: 'PL-77812',
  data: {
    id: 'PL-77812',
    clientID: PAYMENT_ID,
    amountCents: 4850,
    currency: 'EUR',
    lastResult: { txnKey: 'TXN-90311', isApproved: true },
  },
};

function paytefRequest(body: unknown, rawText?: string, headers: Record<string, string> = {}): FastifyRequest {
  const raw = rawText === undefined ? undefined : Buffer.from(rawText, 'utf8');
  return { headers, body, rawBody: raw } as unknown as FastifyRequest;
}

const nothingStored = (h: ReturnType<typeof makeHarness>) => {
  expect(h.prisma.webhookDelivery.create).not.toHaveBeenCalled();
  expect(h.queue.add).not.toHaveBeenCalled();
};

// Reloj fijo: resultReceivedAt y la ventana anti-replay de Paytef.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('receivePaytef — URL secreta', () => {
  it('sin PAYTEF_WEBHOOK_SECRET configurado → 401 sin consultar la pasarela', async () => {
    for (const paytefSecret of ['', null]) {
      const h = makeHarness({ paytefSecret });
      await expect(h.controller.receivePaytef(PAYTEF_SECRET, paytefRequest(PAYTEF_BODY))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(h.gateways.get).not.toHaveBeenCalled();
      nothingStored(h);
    }
  });

  it.each([
    ['misma longitud', PAYTEF_SECRET.replace(/0$/, '1')],
    ['más corto (prefijo)', PAYTEF_SECRET.slice(0, -1)],
    ['más largo', `${PAYTEF_SECRET}0`],
    ['mayúsculas', PAYTEF_SECRET.toUpperCase()],
  ])('secreto incorrecto (%s) → 401, métrica invalid y nada guardado', async (_caso, secret) => {
    const h = makeHarness();
    await expect(h.controller.receivePaytef(secret, paytefRequest(PAYTEF_BODY))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(h.metrics.webhooksReceived.inc).toHaveBeenCalledWith({ provider: 'PAYTEF', outcome: 'invalid' });
    expect(h.gateways.get).not.toHaveBeenCalled();
    nothingStored(h);
  });

  it('secreto correcto pero aviso sin clientID → 401 (lo rechaza el adapter) y nada guardado', async () => {
    const h = makeHarness();
    const body = { paymentID: 'PL-77812', data: { id: 'PL-77812' } };
    await expect(
      h.controller.receivePaytef(PAYTEF_SECRET, paytefRequest(body, JSON.stringify(body))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.metrics.webhooksReceived.inc).toHaveBeenCalledWith({ provider: 'PAYTEF', outcome: 'invalid' });
    expect(h.prisma.webhookDelivery.findUnique).not.toHaveBeenCalled();
    nothingStored(h);
  });

  it('secreto correcto pero firma HMAC de cabecera falsa → 401', async () => {
    const h = makeHarness();
    const headers = { 'x-paytef-signature': 'ab'.repeat(32), 'x-paytef-timestamp': String(NOW.getTime()) };
    await expect(
      h.controller.receivePaytef(PAYTEF_SECRET, paytefRequest(PAYTEF_BODY, JSON.stringify(PAYTEF_BODY), headers)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    nothingStored(h);
  });

  it('el adapter no da id de evento → 400 y métrica invalid', async () => {
    const h = makeHarness();
    vi.spyOn(h.paytef, 'verifyWebhook').mockReturnValue({ valid: true, paymentRef: PAYMENT_ID });
    await expect(h.controller.receivePaytef(PAYTEF_SECRET, paytefRequest(PAYTEF_BODY))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(h.metrics.webhooksReceived.inc).toHaveBeenCalledWith({ provider: 'PAYTEF', outcome: 'invalid' });
    nothingStored(h);
  });

  it('aviso nuevo → guarda los bytes exactos recibidos y encola con jobId determinista', async () => {
    const h = makeHarness();
    const raw = `{ "paymentID": "PL-77812", "data": ${JSON.stringify(PAYTEF_BODY.data)} }`;

    await expect(h.controller.receivePaytef(PAYTEF_SECRET, paytefRequest(PAYTEF_BODY, raw))).resolves.toEqual({
      received: true,
    });

    expect(h.gateways.get).toHaveBeenCalledWith('PAYTEF');
    expect(h.prisma.webhookDelivery.findUnique).toHaveBeenCalledWith({
      where: { provider_externalEventId: { provider: 'PAYTEF', externalEventId: 'PL-77812_TXN-90311' } },
    });
    const data = h.prisma.webhookDelivery.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      provider: 'PAYTEF',
      externalEventId: 'PL-77812_TXN-90311',
      signature: 'paytef-url-secret',
    });
    expect((data.rawBody as Buffer).toString('utf8')).toBe(raw);
    expect(h.queue.add).toHaveBeenCalledWith(
      'process-webhook',
      { deliveryId: '314' },
      { jobId: 'webhook-PAYTEF-PL-77812_TXN-90311', attempts: 8, backoff: { type: 'exponential', delay: 1000 } },
    );
    expect(h.metrics.webhooksReceived.inc).toHaveBeenCalledWith({ provider: 'PAYTEF', outcome: 'valid' });
  });

  it('sin rawBody en la petición → guarda el body serializado', async () => {
    const h = makeHarness();
    await h.controller.receivePaytef(PAYTEF_SECRET, paytefRequest(PAYTEF_BODY));
    const data = h.prisma.webhookDelivery.create.mock.calls[0]![0].data;
    expect(JSON.parse((data.rawBody as Buffer).toString('utf8'))).toEqual(PAYTEF_BODY);
  });

  it('aviso ya procesado → { duplicate: true } sin guardar ni encolar', async () => {
    const h = makeHarness({ existing: { id: BigInt(99), processedAt: new Date('2026-10-17T02:10:00Z') } });
    await expect(h.controller.receivePaytef(PAYTEF_SECRET, paytefRequest(PAYTEF_BODY))).resolves.toEqual({
      received: true,
      duplicate: true,
    });
    nothingStored(h);
    expect(h.metrics.webhooksReceived.inc).toHaveBeenCalledWith({ provider: 'PAYTEF', outcome: 'duplicate' });
  });

  it('aviso guardado pero sin procesar → se reencola el mismo registro con el mismo jobId', async () => {
    const h = makeHarness({ existing: { id: BigInt(99), processedAt: null } });
    await h.controller.receivePaytef(PAYTEF_SECRET, paytefRequest(PAYTEF_BODY));
    await h.controller.receivePaytef(PAYTEF_SECRET, paytefRequest(PAYTEF_BODY));
    expect(h.prisma.webhookDelivery.create).not.toHaveBeenCalled();
    expect(h.queue.add.mock.calls.map((c) => [c[1], c[2].jobId])).toEqual([
      [{ deliveryId: '99' }, 'webhook-PAYTEF-PL-77812_TXN-90311'],
      [{ deliveryId: '99' }, 'webhook-PAYTEF-PL-77812_TXN-90311'],
    ]);
  });
});

describe('peanpeChallenge — POST reto (devuelve el securityToken)', () => {
  const challenge = (body: unknown) => ({ headers: {}, body }) as unknown as FastifyRequest;

  it('id_llamada conocido → devuelve el token de 10 cifras y cuenta el intento por id', async () => {
    const h = makeHarness();
    await expect(h.controller.peanpeChallenge(challenge({ identificador_llamada: ID_LLAMADA }))).resolves.toBe(TOKEN);
    expect(h.redis.eval).toHaveBeenCalledWith(expect.stringContaining('EXPIRE'), 1, `peanpe:challenge-posts:${ID_LLAMADA}`, '60');
    expect(h.metrics.webhooksReceived.inc).toHaveBeenCalledWith({ provider: 'PEANPE', outcome: 'valid' });
  });

  it('id_llamada desconocido → 401 y no se da ningún token', async () => {
    const h = makeHarness({ peanpeCall: null });
    await expect(h.controller.peanpeChallenge(challenge({ identificador_llamada: 'ZZZZZZ' }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(h.metrics.webhooksReceived.inc).not.toHaveBeenCalledWith({ provider: 'PEANPE', outcome: 'valid' });
  });

  it.each([
    ['sin body', undefined],
    ['sin identificador', { status: '200' }],
    ['identificador vacío', { identificador_llamada: '' }],
    ['identificador no texto', { identificador_llamada: 123456 }],
  ])('%s → 400 antes del rate-limit', async (_caso, body) => {
    const h = makeHarness();
    await expect(h.controller.peanpeChallenge(challenge(body))).rejects.toBeInstanceOf(BadRequestException);
    expect(h.redis.eval).not.toHaveBeenCalled();
    expect(h.tx.peanpeCall.findUnique).not.toHaveBeenCalled();
  });

  it('5 intentos en el minuto todavía pasan (límite incluido)', async () => {
    const h = makeHarness({ attempts: 5 });
    await expect(h.controller.peanpeChallenge(challenge({ identificador_llamada: ID_LLAMADA }))).resolves.toBe(TOKEN);
  });

  it.each([6, '6'])('intento %j → 429 sin consultar el token (aunque Redis devuelva texto)', async (attempts) => {
    const h = makeHarness({ attempts });
    const err = await h.controller.peanpeChallenge(challenge({ identificador_llamada: ID_LLAMADA })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(h.tx.peanpeCall.findUnique).not.toHaveBeenCalled();
    expect(h.metrics.webhooksReceived.inc).toHaveBeenCalledWith({ provider: 'PEANPE', outcome: 'invalid' });
  });
});

describe('peanpeResult — GET resultado (seguridad = token del reto)', () => {
  it('seguridad correcta → guarda el aviso con el local y el cobro, anota el resultado y encola', async () => {
    const h = makeHarness();

    await expect(h.controller.peanpeResult(ID_LLAMADA, TOKEN, '200', 'OK', undefined, undefined)).resolves.toEqual({
      received: true,
    });

    const data = h.prisma.webhookDelivery.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      provider: 'PEANPE',
      tenantId: TENANT_ID,
      externalEventId: `${ID_LLAMADA}_pagar_200`,
      signature: 'peanpe-challenge-response',
    });
    expect(JSON.parse((data.rawBody as Buffer).toString('utf8'))).toEqual({
      identificador_llamada: ID_LLAMADA,
      seguridad: TOKEN,
      status: '200',
      msg: 'OK',
      accion: 'pagar',
      debug: '0',
      _paymentId: PAYMENT_ID,
    });
    expect(h.tx.peanpeCall.update).toHaveBeenCalledWith({
      where: { identificadorLlamada: ID_LLAMADA },
      data: { resultStatus: '200', resultMsg: 'OK', resultReceivedAt: NOW },
    });
    expect(h.queue.add).toHaveBeenCalledWith(
      'process-webhook',
      { deliveryId: '314' },
      expect.objectContaining({ jobId: `webhook-PEANPE-${ID_LLAMADA}_pagar_200` }),
    );
    expect(h.metrics.webhooksReceived.inc).toHaveBeenCalledWith({ provider: 'PEANPE', outcome: 'valid' });
  });

  it.each([
    ['otro token de igual longitud', '4829105737'],
    ['token más corto', '482910573'],
    ['todo ceros', '0000000000'],
  ])('seguridad incorrecta (%s) → 401 y nada guardado ni anotado', async (_caso, seguridad) => {
    const h = makeHarness();
    await expect(
      h.controller.peanpeResult(ID_LLAMADA, seguridad, '200', 'OK', undefined, undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.prisma.webhookDelivery.findUnique).not.toHaveBeenCalled();
    expect(h.tx.peanpeCall.update).not.toHaveBeenCalled();
    nothingStored(h);
    expect(h.metrics.webhooksReceived.inc).toHaveBeenCalledWith({ provider: 'PEANPE', outcome: 'invalid' });
  });

  it('id_llamada inventado → 401', async () => {
    const h = makeHarness({ peanpeCall: null });
    await expect(h.controller.peanpeResult('ZZZZZZ', TOKEN, '200', 'OK', undefined, undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    nothingStored(h);
  });

  it.each([
    ['sin seguridad', ID_LLAMADA, undefined, '200'],
    ['sin status', ID_LLAMADA, TOKEN, undefined],
  ])('%s → 400 sin contar intento', async (_caso, id, seguridad, status) => {
    const h = makeHarness();
    await expect(h.controller.peanpeResult(id, seguridad, status, 'OK', undefined, undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(h.redis.eval).not.toHaveBeenCalled();
  });

  it('payload que el adapter no acepta (o sin id de evento) → 400 y nada guardado', async () => {
    for (const verdict of [{ valid: false, reason: 'invalid-payload-shape' }, { valid: true }]) {
      const h = makeHarness();
      vi.spyOn(h.peanpe, 'verifyWebhook').mockReturnValue(verdict);
      await expect(
        h.controller.peanpeResult(ID_LLAMADA, TOKEN, '200', 'OK', undefined, undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(h.metrics.webhooksReceived.inc).toHaveBeenCalledWith({ provider: 'PEANPE', outcome: 'invalid' });
      expect(h.tx.peanpeCall.update).not.toHaveBeenCalled();
      nothingStored(h);
    }
  });

  it('aviso ya procesado → duplicate sin volver a anotar ni encolar', async () => {
    const h = makeHarness({ existing: { id: BigInt(77), processedAt: new Date('2026-10-17T02:00:00Z') } });
    await expect(h.controller.peanpeResult(ID_LLAMADA, TOKEN, '200', 'OK', 'pagar', '0')).resolves.toEqual({
      received: true,
      duplicate: true,
    });
    expect(h.tx.peanpeCall.update).not.toHaveBeenCalled();
    nothingStored(h);
    expect(h.metrics.webhooksReceived.inc).toHaveBeenCalledWith({ provider: 'PEANPE', outcome: 'duplicate' });
  });

  it('aviso guardado sin procesar → reusa el registro, anota y reencola con el mismo jobId', async () => {
    const h = makeHarness({ existing: { id: BigInt(77), processedAt: null } });
    await h.controller.peanpeResult(ID_LLAMADA, TOKEN, '200', 'OK', 'pagar', '0');
    expect(h.prisma.webhookDelivery.create).not.toHaveBeenCalled();
    expect(h.tx.peanpeCall.update).toHaveBeenCalledTimes(1);
    expect(h.queue.add).toHaveBeenCalledWith(
      'process-webhook',
      { deliveryId: '77' },
      expect.objectContaining({ jobId: `webhook-PEANPE-${ID_LLAMADA}_pagar_200` }),
    );
  });

  it('un KO y el OK posterior del mismo id_llamada son avisos distintos (no se deduplican)', async () => {
    const h = makeHarness();
    await h.controller.peanpeResult(ID_LLAMADA, TOKEN, '500', 'Denegada', 'pagar', '0');
    await h.controller.peanpeResult(ID_LLAMADA, TOKEN, '200', 'OK', 'pagar', '0');
    expect(h.queue.add.mock.calls.map((c) => c[2].jobId)).toEqual([
      `webhook-PEANPE-${ID_LLAMADA}_pagar_500`,
      `webhook-PEANPE-${ID_LLAMADA}_pagar_200`,
    ]);
  });

  // Antes el cuerpo sintético llevaba `msg: null` y el esquema del adaptador (msg
  // opcional, no null) lo rechazaba: 400, sin anotar el resultado ni encolarlo.
  it('GET sin msg (opcional) → se acepta igual que con msg', async () => {
    const h = makeHarness();
    await expect(
      h.controller.peanpeResult(ID_LLAMADA, TOKEN, '200', undefined, undefined, undefined),
    ).resolves.toEqual({ received: true });
    expect(h.tx.peanpeCall.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ resultMsg: null }) }),
    );
    expect(h.queue.add).toHaveBeenCalledTimes(1);
  });
});
