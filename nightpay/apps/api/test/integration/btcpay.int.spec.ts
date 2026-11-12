// Integración (Postgres real, np_app con FORCE RLS) de «Pagar con bitcoin»
// (BTCPay Server, fase 1). Un BTCPay de mentira es un servidor HTTP local; el
// cliente de red es el de producción (SafeBtcpayNet) con la comprobación del
// DNS y la IP fijada, solo que apuntando a ese servidor. Cubre: Ajustes del
// dueño (conexión, permisos, aviso registrado, clave cifrada), la factura del
// cobro, el aviso firmado (Settled → Pagado una vez; repetido, nada; firma mala,
// 401), importe/tienda/orderId que no cuadran, recarga (saldo una sola vez),
// cobro cancelado y luego pagado (incidencia), caducada, respaldo por consulta
// y por tarea, el aislamiento entre locales y el mapa del dinero. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { ConflictException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { MoneyMapService } from '../../src/modules/money-map/money-map.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { RefundsService } from '../../src/modules/refunds/refunds.service';
import { SafeBtcpayNet } from '../../src/modules/btcpay/btcpay-net';
import { BtcpayClients } from '../../src/modules/btcpay/btcpay-client';
import { BtcpayStoreService } from '../../src/modules/btcpay/btcpay-store.service';
import { BtcpayInvoiceService } from '../../src/modules/btcpay/btcpay-invoice.service';
import { BtcpayWebhookController } from '../../src/modules/btcpay/btcpay-webhook.controller';
import { BtcpayEnabledGuard } from '../../src/modules/btcpay/btcpay-flag';
import { WebhookIngestProcessor } from '../../src/modules/queues/webhook-ingest.processor';
import { GatewayRegistry } from '../../src/modules/gateways/gateway.registry';
import { BtcpayAdapter } from '../../src/modules/gateways/btcpay.adapter';

process.env.BTCPAY_ENABLED = 'true';
const KEK = 'clave-del-servidor-para-las-pruebas-0123456789';
process.env.ENCRYPTION_KEK = KEK;

// ─── Un BTCPay de mentira ───────────────────────────────────────────────

interface FakeInvoice {
  id: string;
  storeId: string;
  amount: string;
  currency: string;
  status: 'New' | 'Processing' | 'Expired' | 'Invalid' | 'Settled';
  additionalStatus: string;
  metadata: Record<string, unknown>;
  expirationTime: number;
  checkoutLink: string;
}

class FakeBtcpay {
  server!: http.Server;
  port = 0;
  readonly storeId = 'STORE1';
  readonly apiKey = 'clave-btcpay-de-prueba-0000';
  invoices = new Map<string, FakeInvoice>();
  calls: string[] = [];
  permissions: string[] = ['btcpay.store.cancreateinvoice:STORE1', 'btcpay.store.canviewinvoices:STORE1', 'btcpay.store.webhooks.canmodifywebhooks:STORE1'];
  walletLinked = true;
  lightning = true;
  canMarkInvalid = false;
  webhooks = new Map<string, { id: string; url: string; secret: string; events: unknown }>();
  private seq = 0;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => this.handle(req, res, Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  count(prefix: string): number {
    return this.calls.filter((c) => c.startsWith(prefix)).length;
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' }).end(body === undefined ? '' : JSON.stringify(body));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, raw: string): void {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const key = `${req.method} ${path}`;
    this.calls.push(key);
    if (path === '/api/v1/health') return this.send(res, 200, { synchronized: true });
    if (req.headers.authorization !== `token ${this.apiKey}`) {
      return this.send(res, 401, { code: 'unauthenticated', message: 'ApiKey authentication failed' });
    }
    if (path === '/api/v1/api-keys/current') return this.send(res, 200, { id: 'k1', permissions: this.permissions });
    const m = /^\/api\/v1\/stores\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return this.send(res, 404, { code: 'not-found' });
    if (m[1] !== this.storeId) return this.send(res, 404, { code: 'store-not-found', message: 'Store not found' });
    const rest = m[2] ?? '';
    const body = raw ? (JSON.parse(raw) as Record<string, any>) : {};

    if (rest === '/invoices' && req.method === 'GET') return this.send(res, 200, []);
    if (rest === '/invoices' && req.method === 'POST') {
      if (!this.walletLinked) return this.send(res, 400, { code: 'generic-error', message: 'No wallet has been linked to your BTCPay Store.' });
      this.seq += 1;
      const id = `INV${this.seq}${randomUUID().slice(0, 6)}`;
      const inv: FakeInvoice = {
        id,
        storeId: this.storeId,
        amount: body.amount,
        currency: body.currency,
        status: 'New',
        additionalStatus: 'None',
        metadata: body.metadata ?? {},
        expirationTime: Math.floor(Date.now() / 1000) + (body.checkout?.expirationMinutes ?? 15) * 60,
        checkoutLink: `https://btcpay.sala-test.es/i/${id}`,
      };
      this.invoices.set(id, inv);
      return this.send(res, 200, inv);
    }
    const inv = /^\/invoices\/([^/]+)(\/.*)?$/.exec(rest);
    if (inv) {
      const found = this.invoices.get(inv[1] ?? '');
      if (!found) return this.send(res, 404, { code: 'invoice-not-found', message: 'Invoice not found' });
      const sub = inv[2] ?? '';
      if (sub === '' && req.method === 'GET') return this.send(res, 200, found);
      if (sub === '/payment-methods') {
        const rows: unknown[] = [
          { paymentMethodId: 'BTC-CHAIN', destination: 'bc1qfakeaddress0000000000000000000000', paymentLink: `bitcoin:bc1qfakeaddress0000000000000000000000?amount=0.00071234`, amount: '0.00071234', rate: '63200', activated: true },
        ];
        if (this.lightning) {
          rows.push({ paymentMethodId: 'BTC-LN', destination: 'lnbc712340n1p3xyzabcdefghijklmnopqrstuvwxyz0123456789', paymentLink: 'lightning:lnbc712340n1p3xyzabcdefghijklmnopqrstuvwxyz0123456789', amount: '0.00071234', rate: '63200', activated: true });
        }
        return this.send(res, 200, rows);
      }
      if (sub === '/status' && req.method === 'POST') {
        if (!this.canMarkInvalid) return this.send(res, 403, { code: 'missing-permission', missingPermission: 'btcpay.store.canmanageinvoicestatus' });
        found.status = 'Invalid';
        return this.send(res, 200, found);
      }
    }
    if (rest === '/webhooks' && req.method === 'POST') {
      const id = `WH${this.webhooks.size + 1}`;
      this.webhooks.set(id, { id, url: body.url, secret: body.secret, events: body.authorizedEvents });
      return this.send(res, 200, { id, secret: body.secret });
    }
    const hook = /^\/webhooks\/([^/]+)$/.exec(rest);
    if (hook) {
      const found = this.webhooks.get(hook[1] ?? '');
      if (!found) return this.send(res, 404, { code: 'webhook-not-found' });
      if (req.method === 'PUT') {
        this.webhooks.set(found.id, { ...found, url: body.url, secret: body.secret ?? found.secret, events: body.authorizedEvents });
        return this.send(res, 200, { id: found.id });
      }
      if (req.method === 'DELETE') {
        this.webhooks.delete(found.id);
        return this.send(res, 200, undefined);
      }
    }
    return this.send(res, 404, { code: 'not-found' });
  }

  /** Lo que haría el cliente al pagar: la factura pasa a ese estado. */
  setState(invoiceId: string, status: FakeInvoice['status'], additionalStatus = 'None'): void {
    const inv = this.invoices.get(invoiceId);
    if (!inv) throw new Error('factura desconocida');
    inv.status = status;
    inv.additionalStatus = additionalStatus;
  }
}

// ─── El resto de piezas, como en producción ─────────────────────────────

const fake = new FakeBtcpay();
const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const queue = { add: vi.fn(async () => undefined), getJob: vi.fn(async () => null) };
const metrics = {
  paymentsCreated: { inc: vi.fn() },
  paymentsTransitioned: { inc: vi.fn() },
  walletCreditSkipped: { inc: vi.fn() },
  duplicateCharges: { inc: vi.fn() },
  webhooksReceived: { inc: vi.fn() },
  refundsCreated: { inc: vi.fn() },
};
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  { emitPaymentUpdate: vi.fn(), emitPaymentCompleted: vi.fn() } as never,
  metrics as never,
  {} as never,
  {} as never,
);
const audit = { log: vi.fn(async () => undefined) };
const totp = { assertForUser: vi.fn(async () => undefined) };
const config = { get: (k: string) => (k === 'ENCRYPTION_KEK' ? KEK : k === 'NEXT_PUBLIC_API_URL' ? 'https://api.oxio.test' : undefined) };
// El cliente de red es el de producción (SafeBtcpayNet), apuntando al servidor de mentira:
// se crea al arrancar, cuando se conoce su puerto.
let liveNet: SafeBtcpayNet = new SafeBtcpayNet({ resolve: async () => ['93.184.216.34'], transport: http, connectAddress: () => '127.0.0.1' });
const delegatingNet = { checkHost: (o: string) => liveNet.checkHost(o), request: (req: never) => liveNet.request(req) };
const clients = new BtcpayClients(delegatingNet as never);
const stores = new BtcpayStoreService(prisma as never, config as never, delegatingNet as never, clients, totp as never, audit as never);
const invoices = new BtcpayInvoiceService(prisma as never, cls as never, payments, stores);
// La cola de los avisos (aparte de la de caducidad del cobro, que también usa el mock `queue`).
const hookQueue = { add: vi.fn(async () => undefined), getJob: vi.fn(async () => null) };
const hookController = new BtcpayWebhookController(prisma as never, stores, metrics as never, hookQueue as never);
const gateways = new GatewayRegistry({} as never, {} as never, {} as never, {} as never, new BtcpayAdapter());
const processor = new WebhookIngestProcessor(prisma as never, payments, gateways, invoices);
const reports = new ReportsService(prisma);
const moneyMap = new MoneyMapService(prisma, reports, { get: () => undefined } as never);
const refunds = new RefundsService(prisma as never, cls as never, gateways, payments, totp as never, audit as never, metrics as never);

const inCtx = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't-btc' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => inCtx(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let A: string, B: string, owner: string, waiter: string, term: string;
let n = 0;
const key = () => `btc-${r}-${(n += 1)}`;
const OWNER = () => ({ sub: owner, tenantId: A, email: 'dueno@sala.es', role: 'OWNER' }) as never;

function hookUrlOf(): string {
  return [...fake.webhooks.values()].at(-1)?.url ?? '';
}
const sign = (secret: string, body: Buffer) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

async function secretOf(tenantId: string): Promise<{ secret: string; token: string }> {
  const access = await stores.accessFor(tenantId);
  if (!access?.webhookSecret) throw new Error('sin secreto');
  return { secret: access.webhookSecret, token: access.hookToken };
}

async function newPayment(amountCents = 4500, o: { tenant?: string; user?: string } = {}) {
  const tenant = o.tenant ?? A;
  const created = await inCtx(tenant, () =>
    payments.create(tenant, key(), { currency: 'EUR', terminalExternalId: `BTC-${r}`, amountCents } as never, { userId: o.user ?? waiter, role: 'WAITER' }),
  );
  return { id: created.id, token: created.qrToken };
}

const startFor = (token: string) => inCtx(undefined, () => invoices.startForToken(token, 'claim-hash'));
const statusOf = (id: string) => sys((tx) => tx.payment.findUniqueOrThrow({ where: { id } }));
const rowsOf = (paymentId: string) => sys((tx) => tx.btcpayInvoice.findMany({ where: { paymentId }, orderBy: { createdAt: 'asc' } }));

/** El aviso de BTCPay tal como lo manda: firmado con el secreto del local, cuerpo exacto. */
async function sendHook(tenant: string, event: Record<string, unknown>, opts: { secret?: string; token?: string; body?: Buffer } = {}) {
  const { secret, token } = await secretOf(tenant);
  const body = opts.body ?? Buffer.from(JSON.stringify({ webhookId: 'WH1', isRedelivery: false, timestamp: 1, ...event }), 'utf8');
  return hookController.receive(opts.token ?? token, sign(opts.secret ?? secret, body), { rawBody: body } as never);
}

const settle = (invoiceId: string, extra: Record<string, unknown> = {}) => ({
  type: 'InvoiceSettled',
  deliveryId: `d-${randomUUID()}`,
  storeId: fake.storeId,
  invoiceId,
  metadata: {},
  ...extra,
});

async function runQueued(): Promise<void> {
  const deliveries = await prisma.webhookDelivery.findMany({ where: { provider: 'BTCPAY', processedAt: null, tenantId: A }, orderBy: { id: 'asc' } });
  for (const d of deliveries) await processor.process({ data: { deliveryId: d.id.toString() } } as never);
}

beforeAll(async () => {
  await fake.start();
  await prisma.onModuleInit();
  invoices.onModuleInit();
  await sys(async (tx) => {
    A = (await tx.venue.create({ data: { name: 'Sala Satoshi', slug: `btc-a-${r}`, walletGroup: `gbtc-${r}` } })).id;
    B = (await tx.venue.create({ data: { name: 'Sala Otra', slug: `btc-b-${r}`, walletGroup: `gbtc-b-${r}` } })).id;
    owner = (await tx.user.create({ data: { tenantId: A, email: `own-btc-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
    waiter = (await tx.user.create({ data: { tenantId: A, email: `wai-btc-${r}@x.es`, passwordHash: 'x', role: 'WAITER', displayName: 'Dani' } })).id;
    term = (await tx.terminal.create({ data: { tenantId: A, externalId: `BTC-${r}`, label: 'Barra', zone: 'BARRA' } })).id;
    await tx.terminal.create({ data: { tenantId: B, externalId: `BTCB-${r}`, label: 'Barra', zone: 'BARRA' } });
  });
  // La conexión de verdad: por Ajustes, con el BTCPay de mentira (puerto real del servidor local).
  liveNet = new SafeBtcpayNet({ resolve: async () => ['93.184.216.34'], transport: http, connectAddress: () => '127.0.0.1', timeoutMs: 3_000, port: fake.port });
});

afterAll(async () => {
  await fake.stop();
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Cada prueba parte de un local con el bitcoin encendido y la última comprobación buena.
  await sys((tx) => tx.$executeRaw`UPDATE btcpay_stores SET enabled = true, purpose = 'BOTH', "lastCheckOk" = true WHERE "tenantId" = ${A}::uuid`);
  fake.permissions = ['btcpay.store.cancreateinvoice:STORE1', 'btcpay.store.canviewinvoices:STORE1', 'btcpay.store.webhooks.canmodifywebhooks:STORE1'];
  fake.walletLinked = true;
  fake.lightning = true;
  fake.canMarkInvalid = false;
  totp.assertForUser.mockClear();
  hookQueue.add.mockClear();
});

const SAVE = { baseUrl: 'https://btcpay.sala-test.es', storeId: 'STORE1', apiKey: 'clave-btcpay-de-prueba-0000', enabled: true, purpose: 'BOTH' as const, totpCode: '123456' };

// ─── Ajustes del dueño ──────────────────────────────────────────────────

describe('Ajustes → Bitcoin (BTCPay)', () => {
  it('sin configurar: nada guardado y el interruptor de cada local apagado', async () => {
    const v = await stores.view(A);
    expect(v).toMatchObject({ available: true, configured: false, enabled: false, apiKeyHint: null });
  });

  it('guardar: pide la 2FA, prueba la conexión, registra solo el aviso con los eventos que se usan y guarda la clave cifrada', async () => {
    const view = await stores.save(OWNER(), SAVE);
    expect(totp.assertForUser).toHaveBeenCalledWith(owner, '123456', `btcpay:${A}`);
    expect(view).toMatchObject({ configured: true, enabled: true, purpose: 'BOTH', baseUrl: 'https://btcpay.sala-test.es', storeId: 'STORE1', webhookRegistered: true, lastCheckOk: true });
    // La clave no vuelve: solo cómo termina.
    expect(view.apiKeyHint).toBe('…0000');
    expect(JSON.stringify(view)).not.toContain('clave-btcpay-de-prueba');
    // En la base está cifrada y el secreto del aviso también.
    const row = await sys((tx) => tx.btcpayStore.findUniqueOrThrow({ where: { tenantId: A } }));
    expect(row.apiKeyEnc).not.toContain('clave-btcpay');
    expect(row.webhookSecretEnc).toBeTruthy();
    expect(row.webhookSecretEnc).not.toContain((await secretOf(A)).secret);
    expect(row.webhookId).toBe('WH1');
    // El aviso en BTCPay: la ruta con el token del local, solo los eventos usados, y el secreto que guardamos.
    const hook = fake.webhooks.get('WH1')!;
    expect(hook.url).toBe(`https://api.oxio.test/v1/webhooks/btcpay/${row.hookToken}`);
    expect(hook.secret).toBe((await secretOf(A)).secret);
    expect((hook.events as { everything: boolean }).everything).toBe(false);
    // Nada de la clave ni del secreto en el registro.
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('clave-btcpay');
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain(hook.secret);
  });

  it('volver a guardar sin escribir la clave la mantiene y actualiza el mismo aviso (no crea otro)', async () => {
    const before = fake.webhooks.size;
    const view = await stores.save(OWNER(), { ...SAVE, apiKey: undefined, purpose: 'PAYMENTS' });
    expect(view).toMatchObject({ purpose: 'PAYMENTS', webhookRegistered: true });
    expect(fake.webhooks.size).toBe(before);
    expect(hookUrlOf()).toContain('/v1/webhooks/btcpay/');
    await stores.save(OWNER(), { ...SAVE, apiKey: undefined, purpose: 'BOTH' });
  });

  it('cambiar la dirección o la tienda sin escribir la clave de nuevo se rechaza (la clave vieja no viaja a otra dirección)', async () => {
    await expect(stores.save(OWNER(), { ...SAVE, apiKey: undefined, baseUrl: 'https://otro.sala-test.es' })).rejects.toMatchObject({
      response: { code: 'BTCPAY_KEY_REQUIRED' },
    });
    await expect(stores.save(OWNER(), { ...SAVE, apiKey: undefined, storeId: 'STORE2' })).rejects.toMatchObject({ response: { code: 'BTCPAY_KEY_REQUIRED' } });
  });

  it('URL peligrosa: se rechaza antes de llamar a nadie y sin tocar lo guardado', async () => {
    const calls = fake.calls.length;
    for (const baseUrl of ['http://btcpay.sala-test.es', 'https://127.0.0.1', 'https://btcpay.sala-test.es:8443', 'https://u:p@btcpay.sala-test.es', 'https://localhost', 'https://btcpay.sala-test.es/api']) {
      await expect(stores.save(OWNER(), { ...SAVE, baseUrl })).rejects.toMatchObject({ response: { code: expect.stringMatching(/^BTCPAY_URL_/) } });
    }
    expect(fake.calls.length).toBe(calls);
    expect((await stores.view(A)).baseUrl).toBe('https://btcpay.sala-test.es');
  });

  it('un nombre que resuelve a una IP privada se rechaza al guardar', async () => {
    const saved = liveNet;
    liveNet = new SafeBtcpayNet({ resolve: async () => ['169.254.169.254'], transport: http, connectAddress: () => '127.0.0.1', port: fake.port });
    try {
      await expect(stores.save(OWNER(), SAVE)).rejects.toMatchObject({ response: { code: 'BTCPAY_URL_PRIVATE_ADDRESS' } });
    } finally {
      liveNet = saved;
    }
  });

  it('clave mala, faltan permisos, tienda que no existe y sin cartera: mensajes claros y no se guarda nada nuevo', async () => {
    const before = await stores.view(A);
    await expect(stores.save(OWNER(), { ...SAVE, apiKey: 'otra-clave-que-no-vale-0000' })).rejects.toMatchObject({
      response: { code: 'BTCPAY_TEST_FAILED', steps: [expect.anything(), { id: 'key', ok: false, message: expect.stringMatching(/clave/i) }] },
    });
    fake.permissions = ['btcpay.store.cancreateinvoice:STORE1'];
    const perms = await stores.save(OWNER(), SAVE).catch((e: { response: { message: string } }) => e);
    expect((perms as { response: { message: string } }).response.message).toMatch(/canviewinvoices.*canmodifywebhooks|faltan permisos/);
    fake.permissions = ['btcpay.store.cancreateinvoice:STORE1', 'btcpay.store.canviewinvoices:STORE1', 'btcpay.store.webhooks.canmodifywebhooks:STORE1'];
    await expect(stores.save(OWNER(), { ...SAVE, storeId: 'NOEXISTE' })).rejects.toMatchObject({ response: { code: 'BTCPAY_TEST_FAILED' } });
    expect(await stores.view(A)).toMatchObject({ storeId: before.storeId, lastCheckOk: true });
  });

  it('«Probar conexión»: health, permisos y tienda por este orden; avisa de los que faltan y de los que sobran', async () => {
    fake.calls.length = 0;
    fake.permissions = [...fake.permissions, 'btcpay.store.canmodifystoresettings:STORE1'];
    const result = await stores.test(A, {});
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.id)).toEqual(['health', 'key', 'store']);
    expect(result.extraPermissions).toEqual(['btcpay.store.canmodifystoresettings:STORE1']);
    expect(fake.calls.slice(0, 3)).toEqual(['GET /api/v1/health', 'GET /api/v1/api-keys/current', 'GET /api/v1/stores/STORE1/invoices']);
    fake.permissions = ['btcpay.store.cancreateinvoice:STORE1'];
    const bad = await stores.test(A, {});
    expect(bad.ok).toBe(false);
    expect(bad.missingPermissions).toEqual(['btcpay.store.canviewinvoices', 'btcpay.store.webhooks.canmodifywebhooks']);
    expect(bad.steps).toHaveLength(2);
  });

  it('«Probar» con la dirección nueva no usa la clave guardada', async () => {
    await expect(stores.test(A, { baseUrl: 'https://otro.sala-test.es' })).rejects.toMatchObject({ response: { code: 'BTCPAY_KEY_REQUIRED' } });
  });

  it('sin cartera vinculada: lo dice al crear la factura', async () => {
    fake.walletLinked = false;
    const p = await newPayment();
    await expect(startFor(p.token)).rejects.toMatchObject({ response: { code: 'BTCPAY_FAILED', message: expect.stringMatching(/cartera/i) } });
    expect((await statusOf(p.id)).status).toBe('CREATED');
    expect(await rowsOf(p.id)).toHaveLength(0);
  });

  it('el interruptor del servidor apagado: las rutas dan 404', () => {
    const before = process.env.BTCPAY_ENABLED;
    process.env.BTCPAY_ENABLED = 'false';
    try {
      expect(() => new BtcpayEnabledGuard().canActivate()).toThrow(NotFoundException);
      return expect(stores.test(A, {})).rejects.toBeInstanceOf(ConflictException);
    } finally {
      process.env.BTCPAY_ENABLED = before;
    }
  });
});

// ─── La factura del cobro ───────────────────────────────────────────────

describe('la factura del cobro', () => {
  it('importe EXACTO del servidor (con la comisión del servicio), EUR, orderId = cobro, HighSpeed; el cobro pasa a AUTHORIZING con BTCPAY', async () => {
    const p = await newPayment(4500);
    await sys((tx) => tx.payment.update({ where: { id: p.id }, data: { serviceFeeCents: 450, serviceFeeBps: 1000 } }));
    const res = await startFor(p.token);
    expect(res.kind).toBe('invoice');
    if (res.kind !== 'invoice') return;
    expect(res.view).toMatchObject({ amountCents: 4950, status: 'New', amountBtc: '0.00071234' });
    // El QR une bitcoin normal y Lightning.
    expect(res.view.qrLink).toBe('bitcoin:bc1qfakeaddress0000000000000000000000?amount=0.00071234&lightning=lnbc712340n1p3xyzabcdefghijklmnopqrstuvwxyz0123456789');
    expect(res.view.qrImage.startsWith('data:image/png;base64,')).toBe(true);
    const inv = fake.invoices.get(res.view.invoiceId)!;
    expect(inv).toMatchObject({ amount: '49.50', currency: 'EUR', metadata: { orderId: p.id } });
    const pay = await statusOf(p.id);
    expect(pay).toMatchObject({ status: 'AUTHORIZING', provider: 'BTCPAY', providerTxId: inv.id });
    // El plazo del cobro no se queda por detrás del de la factura.
    expect(pay.qrExpiresAt.getTime()).toBeGreaterThanOrEqual(inv.expirationTime * 1000 - 1_000);
    const attempts = await sys((tx) => tx.paymentAttempt.findMany({ where: { paymentId: p.id } }));
    expect(attempts).toEqual([expect.objectContaining({ provider: 'BTCPAY', providerTxId: inv.id, amountCents: 4950, payMethod: 'bitcoin', status: 'PENDING' })]);
  });

  it('si ya hay una factura abierta se reutiliza; dos «Pagar» a la vez abren una sola', async () => {
    const p = await newPayment(1200);
    const [a, b] = await Promise.all([startFor(p.token), startFor(p.token)]);
    expect(a.kind === 'invoice' && b.kind === 'invoice' && a.view.invoiceId === b.view.invoiceId).toBe(true);
    const again = await startFor(p.token);
    expect(again.kind === 'invoice' && again.view.invoiceId).toBe(a.kind === 'invoice' ? a.view.invoiceId : '');
    expect(await rowsOf(p.id)).toHaveLength(1);
    expect([...fake.invoices.values()].filter((i) => (i.metadata as { orderId?: string }).orderId === p.id)).toHaveLength(1);
  });

  it('la base no deja dos facturas abiertas del mismo cobro', async () => {
    const p = await newPayment(900);
    await startFor(p.token);
    await expect(
      sys((tx) =>
        tx.btcpayInvoice.create({
          data: { tenantId: A, paymentId: p.id, invoiceId: `dup-${randomUUID()}`, storeId: 'STORE1', amountCents: 900, checkoutLink: 'https://x', qrLink: 'bitcoin:x', expiresAt: new Date(Date.now() + 60_000) },
        }),
      ),
    ).rejects.toThrow();
  });

  it('el personal (quien hizo el cobro o el encargado) lee y crea la factura; otro camarero, no', async () => {
    const p = await newPayment(2000);
    const actor = (userId: string, role: string) => ({ userId, role, tenantId: A });
    const view = await inCtx(A, () => invoices.startForStaff(p.id, actor(waiter, 'WAITER')));
    expect(view.amountCents).toBe(2000);
    const other = await sys((tx) => tx.user.create({ data: { tenantId: A, email: `otro-btc-${r}-${n}@x.es`, passwordHash: 'x', role: 'WAITER' } }));
    await expect(inCtx(A, () => invoices.viewForStaff(p.id, actor(other.id, 'WAITER')))).rejects.toMatchObject({ status: 403 });
    expect((await inCtx(A, () => invoices.viewForStaff(p.id, actor(owner, 'OWNER'))))?.invoiceId).toBe(view.invoiceId);
    // Otro local: 404.
    await expect(inCtx(B, () => invoices.viewForStaff(p.id, { userId: owner, role: 'OWNER', tenantId: B }))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un local con el bitcoin apagado (o para otra cosa) no abre facturas ni ofrece el botón', async () => {
    await stores.updateMode(OWNER(), { enabled: false, purpose: 'BOTH', totpCode: '123456' });
    const p = await newPayment(700);
    await expect(startFor(p.token)).rejects.toMatchObject({ response: { code: 'BTCPAY_NOT_OFFERED' } });
    expect(await inCtx(undefined, () => payments.getPayPage(p.token))).toMatchObject({ kind: 'choose' });
    expect(((await inCtx(undefined, () => payments.getPayPage(p.token))) as { bitcoin?: boolean }).bitcoin).toBeUndefined();
    await stores.updateMode(OWNER(), { enabled: true, purpose: 'TOPUPS', totpCode: '123456' });
    await expect(startFor(p.token)).rejects.toMatchObject({ response: { code: 'BTCPAY_NOT_OFFERED' } });
    await stores.updateMode(OWNER(), { enabled: true, purpose: 'PAYMENTS', totpCode: '123456' });
    expect(((await inCtx(undefined, () => payments.getPayPage(p.token))) as { bitcoin?: boolean }).bitcoin).toBe(true);
    await stores.updateMode(OWNER(), { enabled: true, purpose: 'BOTH', totpCode: '123456' });
  });

  it('la página de pago de un cobro con factura abierta lleva a la de bitcoin, no a la del banco', async () => {
    const p = await newPayment(1500);
    expect(((await inCtx(undefined, () => payments.getPayPage(p.token))) as { bitcoin?: boolean }).bitcoin).toBe(true);
    await startFor(p.token);
    expect(await inCtx(undefined, () => payments.getPayPage(p.token))).toEqual({ kind: 'bitcoin' });
  });
});

// ─── El aviso de BTCPay ─────────────────────────────────────────────────

describe('el aviso de BTCPay', () => {
  it('firma mala → 401 sin guardar ni encolar nada; cuerpo tocado, también', async () => {
    const p = await newPayment(3000);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    const before = await sys((tx) => tx.webhookDelivery.count({ where: { provider: 'BTCPAY' } }));
    await expect(sendHook(A, settle(res.view.invoiceId), { secret: 'secreto-equivocado' })).rejects.toBeInstanceOf(UnauthorizedException);
    // Firma buena de otro cuerpo.
    const { secret, token } = await secretOf(A);
    const signed = Buffer.from(JSON.stringify(settle(res.view.invoiceId)), 'utf8');
    const tampered = Buffer.from(JSON.stringify({ ...settle(res.view.invoiceId), invoiceId: 'OTRA' }), 'utf8');
    await expect(hookController.receive(token, sign(secret, signed), { rawBody: tampered } as never)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(hookController.receive(token, undefined, { rawBody: signed } as never)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await sys((tx) => tx.webhookDelivery.count({ where: { provider: 'BTCPAY' } }))).toBe(before);
    expect(hookQueue.add).not.toHaveBeenCalled();
    expect((await statusOf(p.id)).status).toBe('AUTHORIZING');
  });

  it('token desconocido → 404; sin el cuerpo crudo (no se puede comprobar la firma) → 503', async () => {
    await expect(hookController.receive('token-que-no-existe-0000', 'sha256=00', { rawBody: Buffer.from('{}') } as never)).rejects.toBeInstanceOf(NotFoundException);
    const { token } = await secretOf(A);
    await expect(hookController.receive(token, 'sha256=00', {} as never)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('el aviso de un local no vale para otro: el token es del local de la firma', async () => {
    const p = await newPayment(3100);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    // Con el secreto de A y el token de A, pero la tienda de otro local en el cuerpo → se ignora.
    const out = await sendHook(A, settle(res.view.invoiceId, { storeId: 'TIENDA-DE-OTRO' }));
    expect(out).toMatchObject({ ignored: 'store' });
  });

  it('tipos que no se usan → 200 y se ignoran', async () => {
    const out = await sendHook(A, { type: 'InvoiceCreated', deliveryId: 'x', storeId: fake.storeId, invoiceId: 'ABC' });
    expect(out).toEqual({ received: true, ignored: 'type' });
  });

  it('Settled → «Pagado» una sola vez; el aviso repetido (mismo originalDeliveryId) no hace nada', async () => {
    const p = await newPayment(4500);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.setState(res.view.invoiceId, 'Settled');
    const event = settle(res.view.invoiceId, { deliveryId: `dlv-1-${r}`, originalDeliveryId: `orig-1-${r}` });
    expect(await sendHook(A, event)).toEqual({ received: true });
    expect(hookQueue.add).toHaveBeenCalledTimes(1);
    await runQueued();
    const pay = await statusOf(p.id);
    expect(pay).toMatchObject({ status: 'AUTHORIZED', provider: 'BTCPAY', providerTxId: res.view.invoiceId });
    expect(pay.authorizedAt).toBeTruthy();
    expect((await sys((tx) => tx.paymentAttempt.findMany({ where: { paymentId: p.id } })))[0]?.status).toBe('APPROVED');
    expect(await rowsOf(p.id)).toEqual([expect.objectContaining({ status: 'Settled' })]);

    // El reenvío de BTCPay (otro deliveryId, el mismo originalDeliveryId) ya está procesado: nada.
    const again = await sendHook(A, { ...event, deliveryId: `dlv-2-${r}`, isRedelivery: true });
    expect(again).toEqual({ received: true, duplicate: true });
    expect(hookQueue.add).toHaveBeenCalledTimes(1);
    // Y procesar el mismo aviso otra vez tampoco cambia nada: ni segunda aprobación ni incidencia.
    await runQueued();
    const events = await sys((tx) => tx.paymentEvent.findMany({ where: { paymentId: p.id } }));
    expect(events.filter((e) => e.eventType === 'payment.authorized')).toHaveLength(1);
    expect(events.filter((e) => e.eventType.startsWith('payment.approval'))).toHaveLength(0);
  });

  it('un aviso Settled con otro tipo (Processing) y otra entrega sobre algo ya pagado no duplica nada', async () => {
    const p = await newPayment(1800);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.setState(res.view.invoiceId, 'Settled');
    await sendHook(A, settle(res.view.invoiceId));
    await sendHook(A, { ...settle(res.view.invoiceId), type: 'InvoiceProcessing' });
    await runQueued();
    const events = await sys((tx) => tx.paymentEvent.findMany({ where: { paymentId: p.id } }));
    expect(events.filter((e) => e.eventType === 'payment.authorized')).toHaveLength(1);
    expect((await statusOf(p.id)).status).toBe('AUTHORIZED');
  });

  it.each([
    ['importe distinto (menos)', { amount: '10.00' }, 'btcpay-amount_mismatch'],
    ['moneda distinta', { currency: 'USD' }, 'btcpay-currency_mismatch'],
    ['otro cobro (orderId)', { metadata: { orderId: randomUUID() } }, 'btcpay-order_mismatch'],
    ['otra tienda', { storeId: 'OTRA' }, 'btcpay-store_mismatch'],
  ])('Settled pero %s → rechazado: no se paga, queda en Incidencias y la factura se cierra', async (_name, tamper, reason) => {
    const p = await newPayment(4500);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.setState(res.view.invoiceId, 'Settled');
    Object.assign(fake.invoices.get(res.view.invoiceId)!, tamper);
    await sendHook(A, settle(res.view.invoiceId));
    await runQueued();
    expect((await statusOf(p.id)).status).toBe('AUTHORIZING');
    const events = await sys((tx) => tx.paymentEvent.findMany({ where: { paymentId: p.id, eventType: 'payment.approval_unverified' } }));
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ provider: 'BTCPAY', source: 'btcpay', reason });
    expect((await rowsOf(p.id))[0]?.closedAt).toBeTruthy();
    // Un segundo aviso no repite la incidencia.
    await sendHook(A, settle(res.view.invoiceId));
    await runQueued();
    expect(await sys((tx) => tx.paymentEvent.count({ where: { paymentId: p.id, eventType: 'payment.approval_unverified' } }))).toBe(1);
  });

  it('caducada sin pagar: la factura se cierra y el cobro sigue abierto para pagarlo de otra forma', async () => {
    const p = await newPayment(2500);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.setState(res.view.invoiceId, 'Expired');
    await sendHook(A, { ...settle(res.view.invoiceId), type: 'InvoiceExpired' });
    await runQueued();
    const pay = await statusOf(p.id);
    expect(pay.status).toBe('AWAITING_CAPTURE');
    expect((await rowsOf(p.id))[0]).toMatchObject({ status: 'Expired' });
    // Puede pagar con tarjeta: la página de pago vuelve a elegir, sin bitcoin abierto.
    expect(await inCtx(undefined, () => payments.getPayPage(p.token))).toMatchObject({ kind: 'choose' });
    // Y con bitcoin otra vez, con una factura nueva.
    const second = await startFor(p.token);
    expect(second.kind === 'invoice' && second.view.invoiceId).not.toBe(res.view.invoiceId);
  });

  it('caducada cuando el plazo del cobro ya pasó: el cobro caduca también (no queda a medias)', async () => {
    const p = await newPayment(2600);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    await sys((tx) => tx.$executeRaw`UPDATE payments SET "qrExpiresAt" = now() - interval '1 minute' WHERE id = ${p.id}::uuid`);
    fake.setState(res.view.invoiceId, 'Invalid');
    await sendHook(A, { ...settle(res.view.invoiceId), type: 'InvoiceInvalid' });
    await runQueued();
    expect((await statusOf(p.id)).status).toBe('EXPIRED');
  });

  it('pagada a medias o tarde: incidencia y nunca «Pagado»; el cobro no se reabre solo', async () => {
    for (const [extra, reason] of [['PaidPartial', 'btcpay-paid_partial'], ['PaidLate', 'btcpay-paid_late']] as const) {
      const p = await newPayment(2700);
      const res = await startFor(p.token);
      if (res.kind !== 'invoice') throw new Error('sin factura');
      fake.setState(res.view.invoiceId, 'Expired', extra);
      await sendHook(A, { ...settle(res.view.invoiceId), type: 'InvoiceExpiredPaidPartial' });
      await runQueued();
      expect((await statusOf(p.id)).status).toBe('AUTHORIZING');
      const ev = await sys((tx) => tx.paymentEvent.findMany({ where: { paymentId: p.id, eventType: 'payment.approval_unverified' } }));
      expect(ev).toHaveLength(1);
      expect(ev[0]?.payload).toMatchObject({ reason });
      expect(await invoices.pollForToken(p.token)).toEqual({ state: 'incident' });
    }
  });
});

// ─── Cancelar, recargas y respaldo ──────────────────────────────────────

describe('cancelar el cobro con la factura abierta', () => {
  it('el personal puede cancelar; la factura se cierra aquí y, si la clave deja, en BTCPay; si no, caduca sola', async () => {
    const p = await newPayment(3300);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.calls.length = 0;
    await inCtx(A, () => payments.cancel(p.id, { userId: waiter, role: 'WAITER', tenantId: A }));
    expect((await statusOf(p.id)).status).toBe('CANCELED');
    expect((await rowsOf(p.id))[0]).toMatchObject({ status: 'Invalid' });
    expect(fake.calls).toContain(`POST /api/v1/stores/STORE1/invoices/${res.view.invoiceId}/status`);
    expect(fake.invoices.get(res.view.invoiceId)?.status).toBe('New'); // sin permiso: caduca sola
  });

  it('con permiso, la factura queda Invalid en BTCPay', async () => {
    fake.canMarkInvalid = true;
    const p = await newPayment(3400);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    await inCtx(A, () => payments.cancel(p.id, { userId: waiter, role: 'WAITER', tenantId: A }));
    expect(fake.invoices.get(res.view.invoiceId)?.status).toBe('Invalid');
  });

  it('un pago que llega después de cancelar es una incidencia, nunca «Pagado»', async () => {
    const p = await newPayment(3500);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    await inCtx(A, () => payments.cancel(p.id, { userId: waiter, role: 'WAITER', tenantId: A }));
    fake.setState(res.view.invoiceId, 'Settled');
    await sendHook(A, settle(res.view.invoiceId));
    await runQueued();
    expect((await statusOf(p.id)).status).toBe('CANCELED');
    const ev = await sys((tx) => tx.paymentEvent.findMany({ where: { paymentId: p.id, eventType: 'payment.approval_unbooked' } }));
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ provider: 'BTCPAY', providerTxId: res.view.invoiceId, fromStatus: 'CANCELED' });
    // Otro aviso del mismo pago no repite la incidencia.
    await sendHook(A, { ...settle(res.view.invoiceId), type: 'InvoiceProcessing' });
    await runQueued();
    expect(await sys((tx) => tx.paymentEvent.count({ where: { paymentId: p.id, eventType: 'payment.approval_unbooked' } }))).toBe(1);
  });

  it('con tarjeta (AUTHORIZING en el banco) sigue sin poder cancelarse', async () => {
    const p = await newPayment(900);
    await sys((tx) => tx.payment.update({ where: { id: p.id }, data: { status: 'AUTHORIZING', provider: 'REDSYS', providerTxId: `RS${r}${n}` } }));
    await expect(inCtx(A, () => payments.cancel(p.id, { userId: waiter, role: 'WAITER', tenantId: A }))).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('recarga del saldo pagada con bitcoin', () => {
  it('suma al saldo UNA sola vez, aunque el aviso llegue dos veces o se repase por consulta', async () => {
    const W = await sys(async (tx) => (await tx.clientWallet.create({ data: { tenantId: A, qrToken: `wbtc-${r}-abcdefgh`, balanceCents: 1000, status: 'ACTIVE', shortCode: `B${r.slice(0, 5)}`.toUpperCase(), walletGroup: `gbtc-${r}` } })).id);
    // La recarga (como la crea recepción o el saldo): un cobro con walletId.
    const token = `btc-top-${r}-${n}`;
    const created = await sys((tx) =>
      tx.payment.create({
        data: {
          tenantId: A, terminalId: term, idempotencyKey: key(), qrToken: token, qrExpiresAt: new Date(Date.now() + 5 * 60_000), amountCents: 5000,
          availableAmountCents: 5000, status: 'CREATED', walletId: W, captureMethod: 'WALLET_TOPUP', revenueCategory: 'EXTRA', createdByUserId: waiter,
        },
      }),
    );
    const res = await startFor(token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.setState(res.view.invoiceId, 'Settled');
    await sendHook(A, settle(res.view.invoiceId));
    await sendHook(A, { ...settle(res.view.invoiceId), type: 'InvoiceProcessing' });
    await runQueued();
    await invoices.processInvoice(A, res.view.invoiceId, 'sweep');
    expect((await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: W } }))).balanceCents).toBe(6000);
    expect((await statusOf(created.id)).status).toBe('AUTHORIZED');
    // Las recargas de bitcoin no se «devuelven a la tarjeta».
    const topUps = await sys((tx) => tx.payment.findMany({ where: { walletId: W, provider: { not: 'BTCPAY' } } }));
    expect(topUps).toHaveLength(0);
  });
});

describe('respaldo si el aviso no llega', () => {
  it('al consultar el estado se pregunta a BTCPay como mucho una vez cada 5 s por factura', async () => {
    const p = await newPayment(2200);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.calls.length = 0;
    expect(await invoices.pollForToken(p.token)).toMatchObject({ state: 'open', status: 'New' });
    expect(await invoices.pollForToken(p.token)).toMatchObject({ state: 'open' });
    expect(await invoices.pollForToken(p.token)).toMatchObject({ state: 'open' });
    expect(fake.count(`GET /api/v1/stores/STORE1/invoices/${res.view.invoiceId}`)).toBe(1);
    // Pasados los 5 s, otra vez.
    await sys((tx) => tx.$executeRaw`UPDATE btcpay_invoices SET "lastCheckedAt" = now() - interval '6 seconds' WHERE "invoiceId" = ${res.view.invoiceId}`);
    await invoices.pollForToken(p.token);
    expect(fake.count(`GET /api/v1/stores/STORE1/invoices/${res.view.invoiceId}`)).toBe(2);
  });

  it('pagada sin aviso: la consulta lo da por pagado con las mismas comprobaciones', async () => {
    const p = await newPayment(2300);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.setState(res.view.invoiceId, 'Settled');
    await sys((tx) => tx.$executeRaw`UPDATE btcpay_invoices SET "lastCheckedAt" = now() - interval '6 seconds' WHERE "invoiceId" = ${res.view.invoiceId}`);
    expect(await invoices.pollForToken(p.token)).toEqual({ state: 'paid' });
    expect((await statusOf(p.id)).status).toBe('AUTHORIZED');
  });

  it('con un importe que no cuadra la consulta tampoco paga (book() no mira el importe: aquí sí)', async () => {
    const p = await newPayment(2400);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.setState(res.view.invoiceId, 'Settled');
    fake.invoices.get(res.view.invoiceId)!.amount = '1.00';
    await sys((tx) => tx.$executeRaw`UPDATE btcpay_invoices SET "lastCheckedAt" = now() - interval '6 seconds' WHERE "invoiceId" = ${res.view.invoiceId}`);
    await invoices.pollForToken(p.token);
    expect((await statusOf(p.id)).status).toBe('AUTHORIZING');
  });

  it('la tarea repasa las facturas abiertas (y solo las abiertas)', async () => {
    const p = await newPayment(2450);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.setState(res.view.invoiceId, 'Settled');
    await sys((tx) => tx.$executeRaw`UPDATE btcpay_invoices SET "lastCheckedAt" = now() - interval '10 minutes' WHERE status IN ('New','Processing')`);
    // (La base de pruebas guarda facturas de otras ejecuciones: aquí solo importa la de este cobro.)
    const out = await invoices.sweepOpen();
    expect(out.checked).toBeGreaterThan(0);
    expect((await statusOf(p.id)).status).toBe('AUTHORIZED');
  });

  it('si BTCPay no contesta, el repaso lo cuenta como fallo y no toca el cobro', async () => {
    const p = await newPayment(2460);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    await sys((tx) => tx.$executeRaw`UPDATE btcpay_invoices SET "lastCheckedAt" = now() - interval '10 minutes' WHERE "invoiceId" = ${res.view.invoiceId}`);
    fake.invoices.delete(res.view.invoiceId);
    const out = await invoices.sweepOpen();
    expect(out.failed).toBeGreaterThanOrEqual(1);
    expect((await statusOf(p.id)).status).toBe('AUTHORIZING');
  });
});

// ─── Aislamiento, devoluciones y dinero ─────────────────────────────────

describe('aislamiento entre locales', () => {
  it('el local B no ve la conexión ni las facturas de A (RLS) y no tiene acceso a su BTCPay', async () => {
    expect(await stores.accessFor(B)).toBeNull();
    const seen = await inCtx(B, () => prisma.withTenant(B, (tx) => tx.btcpayStore.findMany()));
    expect(seen).toHaveLength(0);
    const inv = await inCtx(B, () => prisma.withTenant(B, (tx) => tx.btcpayInvoice.findMany()));
    expect(inv).toHaveLength(0);
    // Procesar una factura de A diciendo que es de B no hace nada.
    const p = await newPayment(1000);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    expect(await invoices.processInvoice(B, res.view.invoiceId, 'poll')).toEqual({ kind: 'UNKNOWN' });
  });
});

describe('devoluciones', () => {
  it('un cobro en bitcoin NO ofrece «Devolución BBVA» ni devolución por la pasarela: 409 con su código', async () => {
    const p = await newPayment(1700);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.setState(res.view.invoiceId, 'Settled');
    await invoices.processInvoice(A, res.view.invoiceId, 'poll');
    expect((await statusOf(p.id)).status).toBe('AUTHORIZED');
    const actor = { userId: owner, role: 'OWNER', tenantId: A } as never;
    await expect(inCtx(A, () => refunds.registerBankRefund({ paymentId: p.id, amountCents: 500, reason: 'prueba' } as never, actor))).rejects.toMatchObject({
      response: { code: 'BITCOIN_REFUND_NOT_AVAILABLE' },
    });
    await expect(inCtx(A, () => refunds.refund({ paymentId: p.id, amountCents: 500, reason: 'prueba' } as never, actor))).rejects.toMatchObject({
      response: { code: 'BITCOIN_REFUND_NOT_AVAILABLE' },
    });
  });
});

describe('el dinero con un cobro en bitcoin', () => {
  it('el mapa del dinero cuadra: venta con método BITCOIN, fuera del banco y en la cartera del local', async () => {
    const T = await sys(async (tx) => {
      const id = (await tx.venue.create({ data: { name: 'Sala Mapa BTC', slug: `btc-m-${r}`, walletGroup: `gbtc-m-${r}` } })).id;
      const own = (await tx.user.create({ data: { tenantId: id, email: `own-m-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
      const wai = (await tx.user.create({ data: { tenantId: id, email: `wai-m-${r}@x.es`, passwordHash: 'x', role: 'WAITER' } })).id;
      const tm = (await tx.terminal.create({ data: { tenantId: id, externalId: `BTCM-${r}`, label: 'Barra', zone: 'BARRA' } })).id;
      await tx.venueNight.create({ data: { tenantId: id, openedAt: new Date(Date.now() - 2 * 3_600_000), openingFloatCents: 0, openedBy: own } });
      await tx.btcpayStore.create({ data: { tenantId: id, baseUrl: 'https://x.es', storeId: 's', apiKeyEnc: 'a:b:c', hookToken: `hk-m-${r}-abcdefghijklmnop`, enabled: true } });
      // Un cobro con tarjeta (banco) y otro con bitcoin, con comisión del servicio.
      const base = { tenantId: id, terminalId: tm, createdByUserId: wai, status: 'AUTHORIZED' as const, revenueCategory: 'VENUE_BAR', captureMethod: 'QR', createdAt: new Date(Date.now() - 3_000_000), authorizedAt: new Date(Date.now() - 3_000_000) };
      const card = await tx.payment.create({ data: { ...base, idempotencyKey: key(), qrToken: `m-c-${r}`, qrExpiresAt: new Date(Date.now() + 9e5), amountCents: 3000, availableAmountCents: 3000, provider: 'REDSYS', providerTxId: `MC${r}` } });
      const btc = await tx.payment.create({ data: { ...base, idempotencyKey: key(), qrToken: `m-b-${r}`, qrExpiresAt: new Date(Date.now() + 9e5), amountCents: 5000, serviceFeeCents: 500, serviceFeeBps: 1000, availableAmountCents: 5000, provider: 'BTCPAY', providerTxId: `MB${r}` } });
      await tx.paymentAttempt.create({ data: { paymentId: card.id, tenantId: id, provider: 'REDSYS', providerTxId: `MC${r}`, status: 'APPROVED', amountCents: 3000, tipCents: 0, payMethod: 'card' } });
      await tx.paymentAttempt.create({ data: { paymentId: btc.id, tenantId: id, provider: 'BTCPAY', providerTxId: `MB${r}`, status: 'APPROVED', amountCents: 5500, tipCents: 0, payMethod: 'bitcoin' } });
      return id;
    });
    const map = await moneyMap.forQuery(T, { night: 'current' } as never, new Date(Date.now() + 1_000));
    expect(map.salesCents).toBe(8000);
    expect(map.inflow).toMatchObject({ cardRailCents: 3000, bitcoinCents: 5000 });
    expect(map.inflow.cardRailCents + map.inflow.cashCents + map.inflow.saldoCents + (map.inflow.bitcoinCents ?? 0)).toBe(map.salesCents);
    expect(map.where.bbvaCents).toBe(3000);
    expect(map.where.bitcoinCents).toBe(5500);
    expect(map.where.totalCents).toBe(map.where.bbvaCents + map.where.cashBoxCents + 5500);
    const o = map.where.owners;
    expect(o.venueCents + o.staffCents + o.saldoCents + (o.oxioPayCents ?? 0) + (o.paidOutCents ?? 0) + (o.commissionsCents ?? 0)).toBe(map.where.totalCents);
    expect(map.serviceFee).toMatchObject({ salesCents: 500, owedCents: 500 });
    // Y el listado de Cobros lo etiqueta «Bitcoin».
    const sales = await sys((tx) => tx.payment.findMany({ where: { tenantId: T }, include: { attempts: true } }));
    expect(sales.filter((s) => s.attempts.some((a) => a.payMethod === 'bitcoin'))).toHaveLength(1);
  });
});
