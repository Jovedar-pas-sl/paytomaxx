import { describe, it, expect } from 'vitest';
import { BtcpayApiError, BtcpayClients } from './btcpay-client';
import { BtcpayNet, type BtcpayHttpRequest, type BtcpayHttpResponse } from './btcpay-net';
import { GatewayTransientError } from '../gateways/gateway-errors';

const json = (status: number, body: unknown): BtcpayHttpResponse => ({ status, body: Buffer.from(body === undefined ? '' : JSON.stringify(body), 'utf8') });

class FakeNet extends BtcpayNet {
  calls: BtcpayHttpRequest[] = [];
  answers: Array<BtcpayHttpResponse | Error> = [];
  checked: string[] = [];
  async checkHost(origin: string): Promise<void> {
    this.checked.push(origin);
  }
  async request(req: BtcpayHttpRequest): Promise<BtcpayHttpResponse> {
    this.calls.push(req);
    const next = this.answers.shift();
    if (!next) throw new Error('sin respuesta preparada');
    if (next instanceof Error) throw next;
    return next;
  }
}

const cfg = { tenantId: 't1', origin: 'https://pay.sala-bambu.es', storeId: 'ST1', apiKey: 'CLAVE-SECRETA' };
function make() {
  const net = new FakeNet();
  const clients = new BtcpayClients(net);
  return { net, client: clients.forStore(cfg), clients };
}

const invoiceBody = {
  id: 'INV1', storeId: 'ST1', amount: '12.50', currency: 'EUR', status: 'New', additionalStatus: 'None',
  metadata: { orderId: 'pay-1' }, expirationTime: 1_800_000_900, checkoutLink: 'https://pay.sala-bambu.es/i/INV1',
};

describe('BtcpayClient', () => {
  it('health: sin clave de API, solo pregunta si el servidor está listo', async () => {
    const { net, client } = make();
    net.answers.push(json(200, { synchronized: true }));
    expect(await client.health()).toEqual({ synchronized: true });
    expect(net.calls[0]).toMatchObject({ method: 'GET', path: '/api/v1/health', origin: cfg.origin });
    expect(net.calls[0]?.headers.Authorization).toBeUndefined();
  });

  it('currentKey: lee los permisos de la clave', async () => {
    const { net, client } = make();
    net.answers.push(json(200, { id: 'k', permissions: ['btcpay.store.cancreateinvoice:ST1'] }));
    expect(await client.currentKey()).toEqual({ permissions: ['btcpay.store.cancreateinvoice:ST1'] });
    expect(net.calls[0]?.path).toBe('/api/v1/api-keys/current');
    expect(net.calls[0]?.headers.Authorization).toBe('token CLAVE-SECRETA');
  });

  it('probeStore: pide una factura de la tienda', async () => {
    const { net, client } = make();
    net.answers.push(json(200, []));
    await client.probeStore();
    expect(net.calls[0]?.path).toBe('/api/v1/stores/ST1/invoices?take=1');
  });

  it('createInvoice: importe exacto en texto, EUR, orderId, HighSpeed y 15 minutos', async () => {
    const { net, client } = make();
    net.answers.push(json(200, invoiceBody));
    const inv = await client.createInvoice({ amountCents: 1250, orderId: 'pay-1', expirationMinutes: 15 });
    expect(inv.id).toBe('INV1');
    const sent = net.calls[0];
    expect(sent).toMatchObject({ method: 'POST', path: '/api/v1/stores/ST1/invoices' });
    expect(JSON.parse(sent?.body ?? '{}')).toEqual({
      amount: '12.50',
      currency: 'EUR',
      metadata: { orderId: 'pay-1' },
      checkout: { speedPolicy: 'HighSpeed', expirationMinutes: 15 },
    });
  });

  it('createInvoice: no admite importes que no sean céntimos enteros', async () => {
    const { client } = make();
    await expect(client.createInvoice({ amountCents: 12.5, orderId: 'x', expirationMinutes: 15 })).rejects.toThrow();
  });

  it('getInvoice: valida la forma de lo que devuelve BTCPay', async () => {
    const { net, client } = make();
    net.answers.push(json(200, invoiceBody));
    expect((await client.getInvoice('INV1')).status).toBe('New');
    expect(net.calls[0]?.path).toBe('/api/v1/stores/ST1/invoices/INV1');
    net.answers.push(json(200, { ...invoiceBody, status: 'Rara' }));
    await expect(client.getInvoice('INV1')).rejects.toBeInstanceOf(BtcpayApiError);
    net.answers.push({ status: 200, body: Buffer.from('<html>no soy json</html>') });
    await expect(client.getInvoice('INV1')).rejects.toBeInstanceOf(BtcpayApiError);
  });

  it('el id de la factura no puede colarse en la ruta', async () => {
    const { net, client } = make();
    await expect(client.getInvoice('../../server/info')).rejects.toThrow();
    await expect(client.getInvoice('a/b')).rejects.toThrow();
    expect(net.calls).toHaveLength(0);
  });

  it('getPaymentMethods: devuelve los métodos de pago de la factura', async () => {
    const { net, client } = make();
    net.answers.push(json(200, [{ paymentMethodId: 'BTC-CHAIN', destination: 'bc1q', paymentLink: 'bitcoin:bc1q?amount=0.1', amount: '0.1', rate: '64000', activated: true }]));
    const methods = await client.getPaymentMethods('INV1');
    expect(methods[0]?.paymentMethodId).toBe('BTC-CHAIN');
    expect(net.calls[0]?.path).toBe('/api/v1/stores/ST1/invoices/INV1/payment-methods');
  });

  it('createWebhook: solo los eventos que se usan, con reenvío automático, y devuelve id y secreto', async () => {
    const { net, client } = make();
    net.answers.push(json(200, { id: 'WH1', secret: 'S3CRETO' }));
    const hook = await client.createWebhook({ url: 'https://api.oxiopay.es/v1/webhooks/btcpay/tok', secret: 'S3CRETO' });
    expect(hook).toEqual({ id: 'WH1', secret: 'S3CRETO' });
    const body = JSON.parse(net.calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      enabled: true,
      automaticRedelivery: true,
      url: 'https://api.oxiopay.es/v1/webhooks/btcpay/tok',
      secret: 'S3CRETO',
      authorizedEvents: { everything: false, specificEvents: ['InvoiceSettled', 'InvoiceExpired', 'InvoiceInvalid', 'InvoiceProcessing', 'InvoiceExpiredPaidPartial', 'InvoicePaidAfterExpiration'] },
    });
    expect(net.calls[0]).toMatchObject({ method: 'POST', path: '/api/v1/stores/ST1/webhooks' });
  });

  it('updateWebhook y deleteWebhook usan el id del aviso', async () => {
    const { net, client } = make();
    net.answers.push(json(200, { id: 'WH1' }), json(200, undefined));
    await client.updateWebhook('WH1', { url: 'https://api.oxiopay.es/v1/webhooks/btcpay/tok', secret: 'NUEVO' });
    await client.deleteWebhook('WH1');
    expect(net.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['PUT /api/v1/stores/ST1/webhooks/WH1', 'DELETE /api/v1/stores/ST1/webhooks/WH1']);
  });

  it('markInvalid: lo intenta; sin permiso (403) no es un fallo, la factura caducará sola', async () => {
    const { net, client } = make();
    net.answers.push(json(200, undefined), json(403, { code: 'missing-permission', missingPermission: 'btcpay.store.canmanageinvoicestatus' }), json(404, null));
    expect(await client.markInvalid('INV1')).toBe(true);
    expect(await client.markInvalid('INV1')).toBe(false);
    expect(await client.markInvalid('INV1')).toBe(false);
    expect(net.calls[0]).toMatchObject({ method: 'POST', path: '/api/v1/stores/ST1/invoices/INV1/status' });
    expect(JSON.parse(net.calls[0]?.body ?? '{}')).toEqual({ status: 'Invalid' });
  });

  it('markInvalid: un fallo de red sí se cuenta como fallo pasajero', async () => {
    const { net, client } = make();
    net.answers.push(new GatewayTransientError('BTCPay sin respuesta'));
    await expect(client.markInvalid('INV1')).rejects.toBeInstanceOf(GatewayTransientError);
  });

  it('un error de BTCPay sale como BtcpayApiError con mensaje para el dueño, sin la clave ni el texto crudo', async () => {
    const { net, client } = make();
    net.answers.push(json(401, { code: 'unauthenticated', message: 'token CLAVE-SECRETA no vale' }));
    const err = await client.currentKey().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BtcpayApiError);
    expect(err).toMatchObject({ status: 401, failure: { code: 'BAD_KEY', transient: false } });
    expect(JSON.stringify(err)).not.toContain('CLAVE-SECRETA');
    expect(String((err as Error).message)).not.toContain('CLAVE-SECRETA');
  });

  it('un 5xx es pasajero (GatewayTransientError) para que se pueda reintentar', async () => {
    const { net, client } = make();
    net.answers.push(json(503, null));
    await expect(client.getInvoice('INV1')).rejects.toBeInstanceOf(GatewayTransientError);
  });

  it('cada local tiene su propio cortacircuitos: uno caído no frena a los demás', async () => {
    const net = new FakeNet();
    const clients = new BtcpayClients(net, { volumeThreshold: 2, errorThresholdPercentage: 50, resetTimeoutMs: 60_000 });
    const sick = clients.forStore({ ...cfg, tenantId: 'enfermo' });
    const healthy = clients.forStore({ ...cfg, tenantId: 'sano' });
    for (let i = 0; i < 4; i += 1) {
      net.answers.push(new GatewayTransientError('BTCPay sin respuesta'));
      await sick.getInvoice('INV1').catch(() => undefined);
    }
    // El del local enfermo está abierto: ya ni llama.
    const before = net.calls.length;
    await expect(sick.getInvoice('INV1')).rejects.toBeInstanceOf(GatewayTransientError);
    expect(net.calls.length).toBe(before);
    // El otro local sigue llamando (las respuestas que sobraron de las llamadas cortadas no cuentan).
    net.answers.length = 0;
    net.answers.push(json(200, invoiceBody));
    expect((await healthy.getInvoice('INV1')).id).toBe('INV1');
  });
});
