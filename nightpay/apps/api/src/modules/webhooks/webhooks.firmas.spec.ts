import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { serializeAndSignJSONRequest } from 'redsys-easy';
import { ProviderSchema } from '@nightpay/contracts';
import { WebhooksController } from './webhooks.controller';
import { RedsysAdapter } from '../gateways/redsys.adapter';
import { WipayAdapter, signWebhook } from '../gateways/wipay.adapter';

// Credenciales PÚBLICAS de pruebas (documentación de Redsys y manual de Cecabank).
const REDSYS_MERCHANT = '999008881';
const REDSYS_KEY = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';
const OTHER_KEY = 'Kq9mT2xV7bN4cR8wE1yH6jL3pS5dF0gA';
const WIPAY = { MerchantID: '111950028', AcquirerBIN: '0000554052', TerminalID: '00000003' };
const WIPAY_CLAVE = '99888888';

// Cobro en "Razzmatazz" (Barcelona).
const PAYMENT_ID = 'aabbccdd-1122-4344-8566-778899aabbcc';
const TENANT_ID = '5d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6';
const DS_ORDER = '2610170001AB';
const NUM_OP = PAYMENT_ID.replace(/-/g, '');
const NOW = new Date('2026-10-17T02:15:00Z');

const CONFIG: Record<string, string | number> = {
  GATEWAY_TIMEOUT_MS: 5000,
  NEXT_PUBLIC_API_URL: 'https://api.oxiopay.es',
  REDSYS_API_URL: 'https://sis-t.redsys.es:25443/sis/realizarPago',
  REDSYS_MERCHANT_CODE: REDSYS_MERCHANT,
  REDSYS_TERMINAL: '1',
  REDSYS_SECRET_KEY: REDSYS_KEY,
  WIPAY_MERCHANT_ID: WIPAY.MerchantID,
  WIPAY_ACQUIRER_BIN: WIPAY.AcquirerBIN,
  WIPAY_TERMINAL_ID: WIPAY.TerminalID,
  WIPAY_CLAVE_ENCRIPTACION: WIPAY_CLAVE,
};

function makeHarness() {
  const metrics = {
    webhooksReceived: { inc: vi.fn() },
    duplicateCharges: { inc: vi.fn() },
    gatewayDuration: { observe: vi.fn() },
    circuitState: { set: vi.fn() },
  };
  const config = { get: vi.fn((k: string) => CONFIG[k]) };
  const tx = {
    paymentAttempt: {
      findUnique: vi.fn().mockResolvedValue({ paymentId: PAYMENT_ID, tenantId: TENANT_ID }),
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    payment: { findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    paymentEvent: { create: vi.fn().mockResolvedValue({}) },
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
  const prisma = {
    asSystem: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    webhookDelivery: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: BigInt(501), processedAt: null, ...data })),
    },
  };
  const redsys = new RedsysAdapter(config as never, metrics as never);
  const wipay = new WipayAdapter(config as never, metrics as never);
  const gateways = { get: vi.fn() };
  const queue = { add: vi.fn().mockResolvedValue(undefined) };
  const controller = new WebhooksController(
    prisma as never, gateways as never, queue as never, metrics as never,
    config as never, { eval: vi.fn() } as never, {} as never, wipay, redsys,
  );
  return { controller, prisma, tx, gateways, queue, metrics, redsys, wipay };
}
type Harness = ReturnType<typeof makeHarness>;

/** Body tal cual lo deja Fastify tras parsear el form-urlencoded. */
const req = (body: unknown) => ({ headers: {}, body }) as unknown as FastifyRequest;

function nothingStored(h: Harness) {
  expect(h.prisma.webhookDelivery.create).not.toHaveBeenCalled();
  expect(h.queue.add).not.toHaveBeenCalled();
}

/** Aviso Redsys firmado con la clave del comercio (o la que se diga). */
function redsysNotice(fields: Record<string, string> = {}, key = REDSYS_KEY): Record<string, string> {
  const params = {
    Ds_Order: DS_ORDER,
    Ds_MerchantCode: REDSYS_MERCHANT,
    Ds_Response: '0000',
    Ds_TransactionType: '0',
    Ds_Amount: '4850',
    Ds_Currency: '978',
    ...fields,
  };
  const s = serializeAndSignJSONRequest(key, { Ds_Merchant_Order: params.Ds_Order, ...params } as never);
  return {
    Ds_SignatureVersion: s.Ds_SignatureVersion,
    Ds_MerchantParameters: s.Ds_MerchantParameters,
    Ds_Signature: s.Ds_Signature,
  };
}

/** Comunicación on-line de Cecabank firmada con la clave del comercio. */
function wipayNotice(overrides: Record<string, string> = {}, clave = WIPAY_CLAVE): Record<string, string> {
  const f: Record<string, string> = {
    ...WIPAY,
    Num_operacion: NUM_OP,
    Importe: '4850',
    TipoMoneda: '978',
    Exponente: '2',
    Referencia: '120004567890',
    Num_aut: '101010',
    ...overrides,
  };
  const Firma = signWebhook({
    claveEncriptacion: clave,
    merchantId: f.MerchantID!,
    acquirerBin: f.AcquirerBIN!,
    terminalId: f.TerminalID!,
    numOperacion: f.Num_operacion!,
    importe: f.Importe!,
    tipoMoneda: f.TipoMoneda!,
    exponente: f.Exponente!,
    referencia: f.Referencia!,
  });
  return { ...f, Firma };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('POST /webhooks/:provider (ruta genérica)', () => {
  // Cada pasarela conocida tiene ruta propia: la genérica las rechaza todas
  // antes de verificar nada, así que su tramo de verificación (líneas 185-239)
  // es inalcanzable con el enum Provider actual.
  it.each(ProviderSchema.options)('%s → 401 sin tocar adapter, BD ni cola', async (provider) => {
    const h = makeHarness();
    for (const name of [provider, provider.toLowerCase()]) {
      await expect(h.controller.receive(name, req({}))).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(h.gateways.get).not.toHaveBeenCalled();
    expect(h.prisma.webhookDelivery.findUnique).not.toHaveBeenCalled();
    nothingStored(h);
  });

  it.each(['stripe', '', 'redsys2'])('pasarela desconocida %j → 400', async (provider) => {
    const h = makeHarness();
    await expect(h.controller.receive(provider, req({}))).rejects.toBeInstanceOf(BadRequestException);
    expect(h.gateways.get).not.toHaveBeenCalled();
  });
});

describe('receiveRedsys — firma del banco', () => {
  it('aviso firmado → se guarda una vez (con local y _paymentId) y se encola', async () => {
    const h = makeHarness();
    const notice = redsysNotice();

    await expect(h.controller.receiveRedsys(req(notice))).resolves.toEqual({ received: true });

    expect(h.prisma.webhookDelivery.create).toHaveBeenCalledTimes(1);
    const data = h.prisma.webhookDelivery.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      provider: 'REDSYS',
      tenantId: TENANT_ID,
      externalEventId: `${DS_ORDER}-0000`,
      signature: notice.Ds_Signature,
    });
    expect((data.rawBody as Buffer).toString('utf8')).toMatch(new RegExp(`&_paymentId=${PAYMENT_ID}$`));
    expect(h.queue.add).toHaveBeenCalledWith(
      'process-webhook',
      { deliveryId: '501' },
      expect.objectContaining({ jobId: `webhook-REDSYS-${DS_ORDER}-0000` }),
    );
    expect(h.metrics.webhooksReceived.inc).toHaveBeenCalledWith({ provider: 'REDSYS', outcome: 'valid' });
  });

  const tamperedAmount = (): Record<string, string> => {
    const n = redsysNotice();
    const params = JSON.parse(Buffer.from(n.Ds_MerchantParameters!, 'base64').toString('utf8'));
    const forged = Buffer.from(JSON.stringify({ ...params, Ds_Amount: '1' })).toString('base64');
    return { ...n, Ds_MerchantParameters: forged };
  };

  it.each<[string, () => Record<string, string>]>([
    ['firmado con otra clave', () => redsysNotice({}, OTHER_KEY)],
    ['importe cambiado tras firmar', tamperedAmount],
    ['firma de otro aviso', () => ({ ...redsysNotice(), Ds_Signature: redsysNotice({ Ds_Response: '0190' }).Ds_Signature! })],
    ['versión de firma distinta', () => ({ ...redsysNotice(), Ds_SignatureVersion: 'HMAC_SHA512_V2' })],
    ['sin Ds_Signature', () => ({ ...redsysNotice(), Ds_Signature: '' })],
    ['otro comercio (bien firmado)', () => redsysNotice({ Ds_MerchantCode: '999008882' })],
    ['body vacío', () => ({})],
  ])('%s → 401, sin buscar el cobro ni guardar nada', async (_caso, build) => {
    const h = makeHarness();
    await expect(h.controller.receiveRedsys(req(build()))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.prisma.asSystem).not.toHaveBeenCalled();
    expect(h.prisma.webhookDelivery.findUnique).not.toHaveBeenCalled();
    nothingStored(h);
    expect(h.metrics.webhooksReceived.inc).toHaveBeenCalledWith({ provider: 'REDSYS', outcome: 'invalid' });
  });

  it('aviso bien firmado pero reenviado días después (replay) → 401', async () => {
    const h = makeHarness();
    const old = redsysNotice({ Ds_Date: '14/10/2026', Ds_Hour: '03:30' });
    await expect(h.controller.receiveRedsys(req(old))).rejects.toBeInstanceOf(UnauthorizedException);
    nothingStored(h);
  });

  it('aviso con fecha/hora de Madrid recientes → se acepta', async () => {
    const h = makeHarness();
    const fresh = redsysNotice({ Ds_Date: '17%2F10%2F2026', Ds_Hour: '04:10' });
    await expect(h.controller.receiveRedsys(req(fresh))).resolves.toEqual({ received: true });
    expect(h.queue.add).toHaveBeenCalledTimes(1);
  });
});

describe('receiveWipay — firma de Cecabank', () => {
  it('aviso firmado → $*$OKY$*$, guardado una vez con su Firma y encolado', async () => {
    const h = makeHarness();
    const notice = wipayNotice();

    await expect(h.controller.receiveWipay(req(notice))).resolves.toBe('$*$OKY$*$');

    const data = h.prisma.webhookDelivery.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      provider: 'WIPAY',
      externalEventId: `${NUM_OP}-approved`,
      signature: notice.Firma,
    });
    const stored = new URLSearchParams((data.rawBody as Buffer).toString('utf8'));
    expect(Object.fromEntries(stored)).toEqual(notice);
    expect(h.queue.add).toHaveBeenCalledWith(
      'process-webhook',
      { deliveryId: '501' },
      expect.objectContaining({ jobId: `webhook-WIPAY-${NUM_OP}-approved` }),
    );
  });

  it.each<[string, () => unknown]>([
    ['importe cambiado tras firmar', () => ({ ...wipayNotice(), Importe: '1' })],
    ['moneda cambiada tras firmar', () => ({ ...wipayNotice(), TipoMoneda: '840' })],
    ['firmado con otra clave', () => wipayNotice({}, '12345678')],
    ['otro comercio (bien firmado)', () => wipayNotice({ MerchantID: '111950099' })],
    ['Firma que no es hex', () => ({ ...wipayNotice(), Firma: 'zz'.repeat(32) })],
    ['sin Firma', () => ({ ...wipayNotice(), Firma: '' })],
    ['body con campos anidados', () => ({ ...wipayNotice(), extra: { a: 1 } })],
  ])('%s → $*$NOK$*$ y nada guardado', async (_caso, build) => {
    const h = makeHarness();
    await expect(h.controller.receiveWipay(req(build()))).resolves.toBe('$*$NOK$*$');
    expect(h.prisma.webhookDelivery.findUnique).not.toHaveBeenCalled();
    nothingStored(h);
    expect(h.metrics.webhooksReceived.inc).toHaveBeenCalledWith({ provider: 'WIPAY', outcome: 'invalid' });
  });

  it('una denegación y el OK posterior de la misma operación no se deduplican', async () => {
    const h = makeHarness();
    await h.controller.receiveWipay(req(wipayNotice({ Num_aut: '', COD_AUT: '190' })));
    await h.controller.receiveWipay(req(wipayNotice()));
    expect(h.queue.add.mock.calls.map((c) => c[2].jobId)).toEqual([
      `webhook-WIPAY-${NUM_OP}-denied`,
      `webhook-WIPAY-${NUM_OP}-approved`,
    ]);
  });

  // La firma del aviso (signWebhook) es la del formulario de pago (signRequest) sin
  // Cifrado + URL_OK + URL_NOK al final, sin separadores. El formulario, con su
  // Firma, lo ve el navegador del cliente: con Referencia = Cifrado+URL_OK+URL_NOK
  // y un Num_aut cualquiera, el aviso pasaba la firma y el cobro quedaba pagado.
  it('aviso forjado con la Firma del formulario de pago → $*$NOK$*$', async () => {
    const h = makeHarness();
    const auth = await h.wipay.authorize({
      tenantId: TENANT_ID,
      paymentId: PAYMENT_ID,
      amountCents: 4850,
      currency: 'EUR',
      terminalExternalId: '',
      reference: PAYMENT_ID,
    });
    const f = auth.checkoutForm!.fields;
    const forged = {
      ...WIPAY,
      Num_operacion: f.Num_operacion,
      Importe: f.Importe,
      TipoMoneda: f.TipoMoneda,
      Exponente: f.Exponente,
      Referencia: `${f.Cifrado}${f.URL_OK}${f.URL_NOK}`,
      Num_aut: '000001',
      Firma: f.Firma,
    };
    await expect(h.controller.receiveWipay(req(forged))).resolves.toBe('$*$NOK$*$');
    nothingStored(h);
  });
});
