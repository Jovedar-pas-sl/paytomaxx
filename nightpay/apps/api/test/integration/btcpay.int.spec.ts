// Integración (Postgres real, np_app con FORCE RLS) de «Pagar con bitcoin»
// (BTCPay Server, fase 1). Un BTCPay de mentira es un servidor HTTP local; el
// cliente de red es el de producción (SafeBtcpayNet) con la comprobación del
// DNS y la IP fijada, solo que apuntando a ese servidor. Cubre: Ajustes del
// dueño (conexión, permisos, aviso registrado, clave cifrada), dónde se ofrece
// (decisión del dueño: al cargar saldo y en los reservados, nunca en un cobro de
// la barra), la factura de una carga, el aviso firmado (Settled → Pagado una
// vez; repetido, nada; firma mala, 401), importe/tienda/orderId que no cuadran,
// recarga (saldo una sola vez), cancelada y luego pagada (incidencia), caducada,
// respaldo por consulta y por tarea, reservados pagados con bitcoin (señal,
// resto, anular: solo en euros), el aislamiento entre locales y el mapa del
// dinero. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { BtcpayPayController } from '../../src/modules/btcpay/btcpay-pay.controller';
import { BtcpayWebhookController } from '../../src/modules/btcpay/btcpay-webhook.controller';
import { BtcpayEnabledGuard } from '../../src/modules/btcpay/btcpay-flag';
import { WebhookIngestProcessor } from '../../src/modules/queues/webhook-ingest.processor';
import { GatewayRegistry } from '../../src/modules/gateways/gateway.registry';
import { BtcpayAdapter } from '../../src/modules/gateways/btcpay.adapter';
import { AuditService } from '../../src/modules/audit/audit.service';
import { ReservationsService } from '../../src/modules/reservations/reservations.service';
import { ReservationOpsService } from '../../src/modules/reservations/reservation-ops.service';
import { ReservationCatalogService } from '../../src/modules/reservations/reservation-catalog.service';
import { nightOf } from '../../src/modules/reservations/reservation-rules';
import { CashTopUpService } from '../../src/modules/wallets/wallet-cash-topup.service';
import { payoutAmounts, walletCash } from '../../src/modules/wallets/wallet-cash-limits';

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
  lastCreate: unknown = null;
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
      this.lastCreate = body;
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

/** Un cobro de la barra (sin saldo): bitcoin ya no se ofrece aquí (decisión del dueño). */
async function newCobro(amountCents = 4500, o: { tenant?: string; user?: string } = {}) {
  const tenant = o.tenant ?? A;
  const created = await inCtx(tenant, () =>
    payments.create(tenant, key(), { currency: 'EUR', terminalExternalId: `BTC-${r}`, amountCents } as never, { userId: o.user ?? waiter, role: 'WAITER' }),
  );
  return { id: created.id, token: created.qrToken };
}

/**
 * Una carga de saldo con QR (la de recepción: un cobro con su saldo nuevo),
 * hecha por `o.user` (el camarero de recepción): bitcoin solo se ofrece al
 * cargar saldo y en los reservados.
 */
async function newPayment(amountCents = 4500, o: { tenant?: string; user?: string } = {}) {
  const tenant = o.tenant ?? A;
  const created = await inCtx(tenant, () =>
    payments.create(tenant, key(), { currency: 'EUR', terminalExternalId: `BTC-${r}`, amountCents, wallet: { create: true } } as never, { userId: owner, role: 'OWNER' }),
  );
  await sys((tx) => tx.payment.update({ where: { id: created.id }, data: { createdByUserId: o.user ?? waiter } }));
  return { id: created.id, token: created.qrToken, walletId: created.walletId as string };
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

/**
 * El repaso (cada 2 min en producción), sin aviso de BTCPay, hasta que `done`.
 * Cada vuelta mira como mucho 200 facturas y la base de pruebas guarda las de
 * otras ejecuciones: se repite unas pocas veces con esta factura por mirar.
 */
async function sweepUntil(invoiceId: string, done: () => Promise<boolean>): Promise<void> {
  for (let round = 0; round < 10 && !(await done()); round += 1) {
    await sys((tx) => tx.$executeRaw`UPDATE btcpay_invoices SET "lastCheckedAt" = now() - interval '10 minutes' WHERE "invoiceId" = ${invoiceId}`);
    await invoices.sweepOpen();
  }
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

const SAVE = { baseUrl: 'https://btcpay.sala-test.es', storeId: 'STORE1', apiKey: 'clave-btcpay-de-prueba-0000', enabled: true, totpCode: '123456' };

// ─── Ajustes del dueño ──────────────────────────────────────────────────

describe('Ajustes → Bitcoin (BTCPay)', () => {
  it('sin configurar: nada guardado y el interruptor de cada local apagado', async () => {
    const v = await stores.view(A);
    expect(v).toMatchObject({ available: true, configured: false, enabled: false, apiKeyHint: null });
  });

  it('guardar: pide la 2FA, prueba la conexión, registra solo el aviso con los eventos que se usan y guarda la clave cifrada', async () => {
    const view = await stores.save(OWNER(), SAVE);
    expect(totp.assertForUser).toHaveBeenCalledWith(owner, '123456', `btcpay:${A}`);
    expect(view).toMatchObject({ configured: true, enabled: true, baseUrl: 'https://btcpay.sala-test.es', storeId: 'STORE1', webhookRegistered: true, lastCheckOk: true });
    // El «para qué» ya no se elige (bitcoin: cargar saldo y reservados).
    expect(view).not.toHaveProperty('purpose');
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
    const view = await stores.save(OWNER(), { ...SAVE, apiKey: undefined });
    expect(view).toMatchObject({ webhookRegistered: true });
    expect(fake.webhooks.size).toBe(before);
    expect(hookUrlOf()).toContain('/v1/webhooks/btcpay/');
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
  it('importe EXACTO del servidor (con la comisión del servicio), EUR, orderId = cobro, MediumSpeed; el cobro pasa a AUTHORIZING con BTCPAY', async () => {
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

  it('un local con el bitcoin apagado no abre facturas ni ofrece el botón', async () => {
    await stores.updateMode(OWNER(), { enabled: false, totpCode: '123456' });
    const p = await newPayment(700);
    await expect(startFor(p.token)).rejects.toMatchObject({ response: { code: 'BTCPAY_NOT_OFFERED' } });
    expect(await inCtx(undefined, () => payments.getPayPage(p.token))).toMatchObject({ kind: 'choose' });
    expect(((await inCtx(undefined, () => payments.getPayPage(p.token))) as { bitcoin?: boolean }).bitcoin).toBeUndefined();
    await stores.updateMode(OWNER(), { enabled: true, totpCode: '123456' });
    expect(((await inCtx(undefined, () => payments.getPayPage(p.token))) as { bitcoin?: boolean }).bitcoin).toBe(true);
  });

  it('un cobro de la barra: ni el botón ni la factura, ni por la página ni por el personal (409 BTCPAY_NOT_OFFERED)', async () => {
    const c = await newCobro(1800);
    const page = (await inCtx(undefined, () => payments.getPayPage(c.token))) as { kind: string; bitcoin?: boolean };
    expect(page.kind).toBe('choose');
    expect(page.bitcoin).toBeUndefined();
    await expect(startFor(c.token)).rejects.toMatchObject({ response: { code: 'BTCPAY_NOT_OFFERED' } });
    await expect(inCtx(A, () => invoices.startForStaff(c.id, { userId: waiter, role: 'WAITER', tenantId: A }))).rejects.toMatchObject({
      response: { code: 'BTCPAY_NOT_OFFERED' },
    });
    expect(await rowsOf(c.id)).toHaveLength(0);
    expect((await statusOf(c.id)).status).toBe('CREATED');
  });

  it('el «para qué» de antes ya no cuenta: con «Cobros» guardado, la barra sigue sin bitcoin y las cargas lo tienen', async () => {
    await sys((tx) => tx.$executeRaw`UPDATE btcpay_stores SET purpose = 'PAYMENTS' WHERE "tenantId" = ${A}::uuid`);
    const c = await newCobro(1900);
    await expect(startFor(c.token)).rejects.toMatchObject({ response: { code: 'BTCPAY_NOT_OFFERED' } });
    const carga = await newPayment(1900);
    expect(((await inCtx(undefined, () => payments.getPayPage(carga.token))) as { bitcoin?: boolean }).bitcoin).toBe(true);
    expect((await startFor(carga.token)).kind).toBe('invoice');
    // Un panel antiguo que aún manda el «para qué»: se acepta y no se guarda.
    await stores.updateMode(OWNER(), { enabled: true, purpose: 'TOPUPS', totpCode: '123456' });
    expect((await sys((tx) => tx.btcpayStore.findUniqueOrThrow({ where: { tenantId: A } }))).purpose).toBe('PAYMENTS');
    expect(await stores.view(A)).not.toHaveProperty('purpose');
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

  it('con tarjeta (AUTHORIZING en el banco): no antes de 2 minutos (409); después, sí (si paga, queda en Incidencias). Con bitcoin, sin esperar (arriba)', async () => {
    const p = await newPayment(900);
    const order = `RS${r}${n}`;
    await sys(async (tx) => {
      await tx.payment.update({ where: { id: p.id }, data: { status: 'AUTHORIZING', provider: 'REDSYS', providerTxId: order } });
      await tx.paymentAttempt.create({ data: { paymentId: p.id, tenantId: A, provider: 'REDSYS', providerTxId: order, amountCents: 900, tipCents: 0, status: 'PENDING' } });
    });
    await expect(inCtx(A, () => payments.cancel(p.id, { userId: waiter, role: 'WAITER', tenantId: A }))).rejects.toMatchObject({
      status: 409,
      response: { code: 'CANCEL_AT_BANK_TOO_SOON' },
    });
    expect((await statusOf(p.id)).status).toBe('AUTHORIZING');
    await sys((tx) => tx.$executeRaw`UPDATE payment_attempts SET "createdAt" = now() - interval '3 minutes' WHERE "paymentId" = ${p.id}::uuid`);
    await expect(inCtx(A, () => payments.cancel(p.id, { userId: waiter, role: 'WAITER', tenantId: A }))).resolves.toEqual({ status: 'CANCELED' });
  });

  it('con el bitcoin ya en la red (Processing) NO se cancela: 409 BITCOIN_CONFIRMING y no se toca nada', async () => {
    const p = await newPayment(3600);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.setState(res.view.invoiceId, 'Processing');
    await invoices.processInvoice(A, res.view.invoiceId, 'poll');
    await expect(inCtx(A, () => payments.cancel(p.id, { userId: waiter, role: 'WAITER', tenantId: A }))).rejects.toMatchObject({
      status: 409,
      response: { code: 'BITCOIN_CONFIRMING' },
    });
    expect((await statusOf(p.id)).status).toBe('AUTHORIZING');
    expect((await rowsOf(p.id))[0]).toMatchObject({ status: 'Processing', closedAt: null });
  });

  it('cancelado sin poder invalidarla en BTCPay: el repaso la sigue mirando y un pago que llega después es incidencia', async () => {
    const p = await newPayment(3700);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    await inCtx(A, () => payments.cancel(p.id, { userId: waiter, role: 'WAITER', tenantId: A }));
    // Cerrada aquí, abierta allí (la clave no tiene ese permiso): sin closedAt, el repaso la vigila.
    expect((await rowsOf(p.id))[0]).toMatchObject({ status: 'Invalid', closedAt: null });
    fake.setState(res.view.invoiceId, 'Settled');
    await sweepUntil(res.view.invoiceId, async () => Boolean((await rowsOf(p.id))[0]?.closedAt));
    expect((await statusOf(p.id)).status).toBe('CANCELED');
    const ev = await sys((tx) => tx.paymentEvent.findMany({ where: { paymentId: p.id, eventType: 'payment.approval_unbooked' } }));
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ provider: 'BTCPAY', providerTxId: res.view.invoiceId, fromStatus: 'CANCELED' });
    expect((await rowsOf(p.id))[0]).toMatchObject({ status: 'Settled' });
  });

  it('cancelado sin pago: mientras siga abierta en BTCPay se queda cerrada aquí (no vuelve a «New») y al caducar allí se da por cerrada', async () => {
    const p = await newPayment(3800);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    await inCtx(A, () => payments.cancel(p.id, { userId: waiter, role: 'WAITER', tenantId: A }));
    await invoices.processInvoice(A, res.view.invoiceId, 'sweep');
    expect((await rowsOf(p.id))[0]).toMatchObject({ status: 'Invalid', closedAt: null });
    fake.setState(res.view.invoiceId, 'Expired');
    await invoices.processInvoice(A, res.view.invoiceId, 'sweep');
    expect((await rowsOf(p.id))[0]).toMatchObject({ status: 'Expired' });
    expect((await rowsOf(p.id))[0]?.closedAt).toBeTruthy();
    expect((await statusOf(p.id)).status).toBe('CANCELED');
  });
});

describe('la pantalla del personal sabe si el cliente paga con bitcoin (GET /payments/public/:qrToken)', () => {
  const pub = (token: string) => inCtx(undefined, () => payments.getByToken(token));

  it('factura esperando el pago → «open» (se puede cancelar); en la red → «confirming»; pagado → nada', async () => {
    const p = await newPayment(3900);
    expect(await pub(p.token)).not.toHaveProperty('bitcoin');
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    expect(await pub(p.token)).toMatchObject({ status: 'AUTHORIZING', bitcoin: 'open' });
    fake.setState(res.view.invoiceId, 'Processing');
    await invoices.processInvoice(A, res.view.invoiceId, 'poll');
    expect(await pub(p.token)).toMatchObject({ status: 'AUTHORIZING', bitcoin: 'confirming' });
    fake.setState(res.view.invoiceId, 'Settled');
    await invoices.processInvoice(A, res.view.invoiceId, 'poll');
    const paid = await pub(p.token);
    expect(paid.status).toBe('AUTHORIZED');
    expect(paid).not.toHaveProperty('bitcoin');
  });

  it('pago a medias (la factura se cerró con incidencia y el cobro sigue AUTHORIZING) → «problem»; con tarjeta en su banco → «none»', async () => {
    const p = await newPayment(4000);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.setState(res.view.invoiceId, 'Expired', 'PaidPartial');
    await invoices.processInvoice(A, res.view.invoiceId, 'poll');
    expect(await pub(p.token)).toMatchObject({ status: 'AUTHORIZING', bitcoin: 'problem' });
    const card = await newPayment(4100);
    await sys((tx) => tx.payment.update({ where: { id: card.id }, data: { status: 'AUTHORIZING', provider: 'REDSYS', providerTxId: `RSP${r}${n}` } }));
    // En su banco, se dice ('none'): la pantalla no lo deduce de que falte el campo.
    expect(await pub(card.token)).toMatchObject({ bitcoin: 'none' });
  });
});

describe('«Pagar de otra forma» desde la página del QR', () => {
  const leave = (token: string) => inCtx(undefined, () => invoices.leaveForToken(token));

  it('cierra la factura, el cobro vuelve a estar abierto y /pay/:token ya no lleva al QR (no rebota); se puede volver al bitcoin con otra factura', async () => {
    const p = await newPayment(4200);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.calls.length = 0;
    expect(await leave(p.token)).toEqual({ kind: 'choose' });
    expect((await statusOf(p.id)).status).toBe('AWAITING_CAPTURE');
    // La pantalla del personal lo sabe aunque no hubiera visto antes que era bitcoin: vuelve a estar abierto.
    expect(await inCtx(undefined, () => payments.getByToken(p.token))).toMatchObject({ status: 'AWAITING_CAPTURE', bitcoin: 'closed' });
    // Se pidió a BTCPay que la invalidara; esta clave no puede: cerrada aquí y vigilada por el repaso.
    expect(fake.calls).toContain(`POST /api/v1/stores/STORE1/invoices/${res.view.invoiceId}/status`);
    expect((await rowsOf(p.id))[0]).toMatchObject({ status: 'Invalid', closedAt: null });
    // La página de pago enseña las formas de pago (con el bitcoin también), sin volver al QR.
    expect(await inCtx(undefined, () => payments.getPayPage(p.token))).toMatchObject({ kind: 'choose', bitcoin: true });
    expect((await inCtx(undefined, () => invoices.viewForToken(p.token))).view).toBeNull();
    expect(await invoices.pollForToken(p.token)).toEqual({ state: 'closed', reopened: true });
    // Y otra vez con bitcoin: una factura nueva.
    const again = await startFor(p.token);
    expect(again.kind === 'invoice' && again.view.invoiceId).not.toBe(res.view.invoiceId);
    expect(await inCtx(undefined, () => payments.getPayPage(p.token))).toEqual({ kind: 'bitcoin' });
  });

  it('con permiso en la clave, la factura queda Invalid también en BTCPay y se da por cerrada', async () => {
    fake.canMarkInvalid = true;
    const p = await newPayment(4300);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    expect(await leave(p.token)).toEqual({ kind: 'choose' });
    expect(fake.invoices.get(res.view.invoiceId)?.status).toBe('Invalid');
    expect((await rowsOf(p.id))[0]?.closedAt).toBeTruthy();
  });

  it('con el pago ya en la red no se cierra (vuelve al QR, que dice que se confirma); si ya llegó, «Pagado»', async () => {
    const p = await newPayment(4400);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.setState(res.view.invoiceId, 'Processing');
    expect(await leave(p.token)).toEqual({ kind: 'confirming' });
    expect((await statusOf(p.id)).status).toBe('AUTHORIZING');
    expect((await rowsOf(p.id))[0]).toMatchObject({ status: 'Processing', closedAt: null });
    fake.setState(res.view.invoiceId, 'Settled');
    expect(await leave(p.token)).toEqual({ kind: 'paid' });
    expect((await statusOf(p.id)).status).toBe('AUTHORIZED');
  });

  it('pagada en BTCPay justo antes de tocar el botón: se pregunta antes de cerrar y sale «Pagado» (nunca se cierra pagada)', async () => {
    const p = await newPayment(4500);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.setState(res.view.invoiceId, 'Settled');
    expect(await leave(p.token)).toEqual({ kind: 'paid' });
    expect((await statusOf(p.id)).status).toBe('AUTHORIZED');
    expect((await rowsOf(p.id))[0]).toMatchObject({ status: 'Settled' });
  });

  it('el cliente paga esa factura después de todo (la clave no la invalidó): el repaso lo ve y queda en Incidencias, nunca «Pagado» a ciegas', async () => {
    const p = await newPayment(4600);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    await leave(p.token);
    fake.setState(res.view.invoiceId, 'Settled');
    await sweepUntil(res.view.invoiceId, async () => Boolean((await rowsOf(p.id))[0]?.closedAt));
    expect((await statusOf(p.id)).status).toBe('AWAITING_CAPTURE');
    const ev = await sys((tx) => tx.paymentEvent.findMany({ where: { paymentId: p.id, eventType: 'payment.approval_unbooked' } }));
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ provider: 'BTCPAY', providerTxId: res.view.invoiceId, fromStatus: 'AWAITING_CAPTURE' });
  });

  it('pagado con tarjeta y además con esa factura de bitcoin: el bitcoin de más queda en Incidencias (antes se perdía en silencio)', async () => {
    const p = await newPayment(4700);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    await leave(p.token);
    // El cliente paga con tarjeta (Redsys lo aprueba).
    await sys((tx) => tx.payment.update({ where: { id: p.id }, data: { status: 'AUTHORIZED', provider: 'REDSYS', providerTxId: `RSB${r}${n}`, authorizedAt: new Date() } }));
    fake.setState(res.view.invoiceId, 'Settled');
    await sweepUntil(res.view.invoiceId, async () => Boolean((await rowsOf(p.id))[0]?.closedAt));
    expect(await statusOf(p.id)).toMatchObject({ status: 'AUTHORIZED', provider: 'REDSYS' });
    const ev = await sys((tx) => tx.paymentEvent.findMany({ where: { paymentId: p.id, eventType: 'payment.approval_unbooked' } }));
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ provider: 'BTCPAY', providerTxId: res.view.invoiceId, fromStatus: 'AUTHORIZED', paidWith: 'REDSYS' });
    // Otro repaso o aviso no repite la incidencia.
    await invoices.processInvoice(A, res.view.invoiceId, 'poll');
    expect(await sys((tx) => tx.paymentEvent.count({ where: { paymentId: p.id, eventType: 'payment.approval_unbooked' } }))).toBe(1);
  });

  it('POST /pay/:token/bitcoin/other: 303 a /pay/:token (o al QR si el pago está en la red)', async () => {
    const controller = new BtcpayPayController(invoices, { get: () => 'secreto-de-cookies-de-pruebas-0123456789' } as never);
    const reply = () => {
      const r2 = { code: 0, headers: {} as Record<string, string>, status(c: number) { r2.code = c; return r2; }, header(k: string, v: string) { r2.headers[k] = v; return r2; }, send() { return r2; } };
      return r2;
    };
    const p = await newPayment(4800);
    await startFor(p.token);
    const out = reply();
    await inCtx(undefined, () => controller.other(p.token, 'es', undefined, out as never));
    expect(out.code).toBe(303);
    expect(out.headers.Location).toBe(`/pay/${p.token}?lang=es`);
    const q = await newPayment(4900);
    const res = await startFor(q.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.setState(res.view.invoiceId, 'Processing');
    const back = reply();
    await inCtx(undefined, () => controller.other(q.token, 'en', undefined, back as never));
    expect(back.headers.Location).toBe(`/pay/${q.token}/bitcoin?lang=en`);
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

// ─── Reservados pagados con bitcoin ─────────────────────────────────────

describe('reservados pagados con bitcoin (la señal y el resto), como con tarjeta', () => {
  // Las piezas de los reservados, como en producción (reservados.int.spec.ts), sobre el mismo local con bitcoin.
  const memo = new Map<string, string>();
  const redis = {
    set: async (k: string, v: string, ...flags: unknown[]) => {
      if (flags.includes('NX') && memo.has(k)) return null;
      memo.set(k, v);
      return 'OK';
    },
    del: async (k: string) => (memo.delete(k) ? 1 : 0),
  };
  const realAudit = new AuditService(prisma, cls as never);
  const reservations = new ReservationsService(prisma, payments, redis as never, realAudit);
  const ops = new ReservationOpsService(prisma, realAudit, reservations, payments, new CashTopUpService(prisma, realAudit, {} as never));
  const catalog = new ReservationCatalogService(prisma, realAudit, { get: () => 'https://api.prueba.es' } as never);
  const ownerActor = () => ({ userId: owner, role: 'OWNER' as const, tenantId: A });
  const plusDays = (day: string, d: number) => new Date(Date.parse(`${day}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
  const resvOf = (id: string) => sys((tx) => tx.reservation.findUniqueOrThrow({ where: { id } }));
  const balanceOf = async (walletId: string) => (await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: walletId } }))).balanceCents;
  let pkg = '';
  let nights = 0;

  afterAll(async () => {
    // El resto de pruebas, con el local sin pasarela de tarjeta (como antes).
    await sys((tx) => tx.gatewayCredential.updateMany({ where: { tenantId: A }, data: { active: false } }));
  });

  async function booked() {
    if (!pkg) {
      // Reservar pide la pasarela de tarjeta del local (la señal también se puede pagar con tarjeta).
      await sys((tx) =>
        tx.gatewayCredential.create({
          data: { tenantId: A, provider: 'REDSYS', encKey: Buffer.from('k'), encNonce: Buffer.from('n'), encTag: Buffer.from('t'), kekVersion: 1 },
        }),
      );
      pkg = (
        await inCtx(A, () =>
          catalog.createPackage(ownerActor(), { name: 'Mesa bitcoin', kind: 'CREDIT', priceCents: 40000, creditCents: 30000, entries: 4, items: [] }),
        )
      ).id;
      await inCtx(A, () => catalog.setEnabled(ownerActor(), true));
    }
    const settings = await inCtx(A, () => catalog.settings(A));
    const code = (settings.url ?? '').split('/reservar/')[1] ?? '';
    const entry = await inCtx(undefined, () => reservations.entryByVenueCode(code));
    if (!entry) throw new Error('sin entrada web');
    nights += 1;
    const night = plusDays(nightOf(new Date()), 5 + nights);
    return inCtx(undefined, () =>
      reservations.book(entry, {
        packageId: pkg,
        nightDate: night,
        customerName: 'Laura Gómez',
        customerPhone: '600 11 22 33',
        key: `kb${randomUUID().replace(/-/g, '')}`.slice(0, 24),
      }),
    );
  }

  /** «Pagar la señal / el resto / todo» en la página del grupo y, en /pay, «Pagar con bitcoin». */
  async function payWithBitcoin(manageToken: string, kind: 'DEPOSIT' | 'REST' | 'FULL') {
    const started = await inCtx(undefined, () => reservations.startPayment(manageToken, kind, 'es'));
    const page = (await inCtx(undefined, () => payments.getPayPage(started.payToken))) as { kind: string; bitcoin?: boolean; topUp?: boolean };
    expect(page).toMatchObject({ kind: 'choose', bitcoin: true, topUp: true });
    const res = await startFor(started.payToken);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    const payment = await sys((tx) => tx.payment.findUniqueOrThrow({ where: { qrToken: started.payToken } }));
    return { token: started.payToken, invoiceId: res.view.invoiceId, payment };
  }

  it('la señal con bitcoin: en la red aún no cuenta; pagada → Señal pagada y al saldo del grupo; el resto con bitcoin → Pagada', async () => {
    const res = await booked();
    const dep = await payWithBitcoin(res.manageToken, 'DEPOSIT');
    expect(dep.payment).toMatchObject({ amountCents: 12000, status: 'AUTHORIZING', provider: 'BTCPAY' });
    expect(dep.payment.walletId).not.toBeNull();
    expect(dep.payment.idempotencyKey).toBe(`resv:${res.id}:DEPOSIT:1`);
    // Con el pago en la red (falta 1 confirmación): nada pagado todavía.
    fake.setState(dep.invoiceId, 'Processing');
    await invoices.processInvoice(A, dep.invoiceId, 'poll');
    expect(await resvOf(res.id)).toMatchObject({ status: 'PENDING', paidCents: 0, walletId: null });
    // Confirmado: como con tarjeta.
    fake.setState(dep.invoiceId, 'Settled');
    await sendHook(A, settle(dep.invoiceId));
    await runQueued();
    expect((await statusOf(dep.payment.id)).status).toBe('AUTHORIZED');
    expect(await resvOf(res.id)).toMatchObject({ status: 'DEPOSIT_PAID', paidCents: 12000, walletId: dep.payment.walletId });
    expect(await balanceOf(dep.payment.walletId!)).toBe(12000);
    expect(await sys((tx) => tx.reservationPayment.findUniqueOrThrow({ where: { paymentId: dep.payment.id } }))).toMatchObject({ kind: 'DEPOSIT', amountCents: 12000 });
    // El aviso repetido no lo cuenta dos veces.
    await sendHook(A, { ...settle(dep.invoiceId), type: 'InvoiceProcessing' });
    await runQueued();
    await invoices.processInvoice(A, dep.invoiceId, 'sweep');
    expect((await resvOf(res.id)).paidCents).toBe(12000);
    expect(await balanceOf(dep.payment.walletId!)).toBe(12000);
    // Al pagarse, el navegador que pagó vuelve a la página del reservado (como con tarjeta).
    expect(await inCtx(undefined, () => payments.reservationManageToken(dep.payment.id))).toBe(res.manageToken);

    const rest = await payWithBitcoin(res.manageToken, 'REST');
    expect(rest.payment).toMatchObject({ amountCents: 28000, walletId: dep.payment.walletId });
    fake.setState(rest.invoiceId, 'Settled');
    await invoices.processInvoice(A, rest.invoiceId, 'poll');
    expect(await resvOf(res.id)).toMatchObject({ status: 'PAID', paidCents: 40000 });
    expect(await balanceOf(dep.payment.walletId!)).toBe(40000);
    // El panel sabe cuánto se pagó con bitcoin.
    expect(await inCtx(A, () => ops.detail(ownerActor(), res.id))).toMatchObject({ paidCents: 40000, paidWithBitcoinCents: 40000 });
  });

  it('el local anula una reserva pagada con bitcoin: queda como saldo del grupo; nada sale por la pasarela ni en bitcoin y «Devolver saldo» no lo saca', async () => {
    const res = await booked();
    const full = await payWithBitcoin(res.manageToken, 'FULL');
    fake.setState(full.invoiceId, 'Settled');
    await invoices.processInvoice(A, full.invoiceId, 'poll');
    expect(await resvOf(res.id)).toMatchObject({ status: 'PAID', paidCents: 40000 });

    const out = await inCtx(A, () => ops.venueCancel(ownerActor(), res.id, 'Cerramos esa noche'));
    expect(out).toMatchObject({ saldoCents: 40000, walletId: full.payment.walletId });
    expect(out.reservation).toMatchObject({ status: 'CANCELED', paidWithBitcoinCents: 40000 });
    // Lo pagado con bitcoin se queda en el saldo del grupo para otra noche (decisión del dueño del 17-nov).
    expect(await balanceOf(full.payment.walletId!)).toBe(40000);
    // Por la pasarela: 409 con su código (solo en euros); no se crea ninguna devolución.
    const actor = { userId: owner, role: 'OWNER', tenantId: A } as never;
    await expect(inCtx(A, () => refunds.refund({ paymentId: full.payment.id, amountCents: 40000, reason: 'Anulada' } as never, actor))).rejects.toMatchObject({
      response: { code: 'SALDO_NO_SE_DEVUELVE' }, // es una carga del saldo del grupo: el saldo no se devuelve
    });
    expect(await sys((tx) => tx.refund.count({ where: { paymentId: full.payment.id } }))).toBe(0);
    // «Devolver saldo»: ni a la tarjeta ni en efectivo (entró con bitcoin): en euros, lo decide el dueño.
    const amounts = await inCtx(undefined, () => prisma.acrossVenues(async (tx) => payoutAmounts(40000, await walletCash(tx, full.payment.walletId!))));
    expect(amounts).toMatchObject({ cardRefundCents: 0, cashOutCents: 0, bitcoinCents: 40000 });
    expect((await statusOf(full.payment.id)).status).toBe('AUTHORIZED');
  });

  it('el pago a medias: con la factura abierta, «Seguir pagando» vuelve a ella; cerrada sin pagar, otro tipo de pago la cancela', async () => {
    const res = await booked();
    const dep = await payWithBitcoin(res.manageToken, 'DEPOSIT');
    const group = await inCtx(undefined, () => reservations.groupView(res.manageToken));
    expect(group?.openPayUrl).toBe(`/pay/${encodeURIComponent(dep.token)}`);
    // El mismo pago: el mismo cobro (su factura); otro tipo con el bitcoin abierto: hay que esperar.
    expect((await inCtx(undefined, () => reservations.startPayment(res.manageToken, 'DEPOSIT', 'es'))).payToken).toBe(dep.token);
    await expect(inCtx(undefined, () => reservations.startPayment(res.manageToken, 'FULL', 'es'))).rejects.toMatchObject({
      response: { code: 'RESERVATION_PAY_OPEN' },
    });
    // «Pagar de otra forma»: la factura se cierra y el cobro vuelve a estar abierto (AWAITING_CAPTURE).
    expect(await inCtx(undefined, () => invoices.leaveForToken(dep.token))).toEqual({ kind: 'choose' });
    expect((await statusOf(dep.payment.id)).status).toBe('AWAITING_CAPTURE');
    expect((await inCtx(undefined, () => reservations.groupView(res.manageToken)))?.openPayUrl).toBe(`/pay/${encodeURIComponent(dep.token)}`);
    expect((await inCtx(undefined, () => reservations.startPayment(res.manageToken, 'DEPOSIT', 'es'))).payToken).toBe(dep.token);
    // Cambia a «todo»: el de antes se cancela (antes se quedaba abierto y se podía pagar dos veces).
    const all = await inCtx(undefined, () => reservations.startPayment(res.manageToken, 'FULL', 'es'));
    expect(all.payToken).not.toBe(dep.token);
    expect((await statusOf(dep.payment.id)).status).toBe('CANCELED');
  });

  /** El cliente paga la factura al final (ya anulada la reserva o cobrado el resto): el cobro sigue cancelado y queda en Incidencias. */
  async function paysAnyway(invoiceId: string, paymentId: string): Promise<void> {
    fake.setState(invoiceId, 'Settled');
    await sendHook(A, settle(invoiceId));
    await runQueued();
    expect((await statusOf(paymentId)).status).toBe('CANCELED');
    expect(await sys((tx) => tx.paymentEvent.count({ where: { paymentId, eventType: 'payment.approval_unbooked' } }))).toBe(1);
  }
  const canceledEvent = (paymentId: string) => sys((tx) => tx.paymentEvent.findFirst({ where: { paymentId, eventType: 'payment.canceled' } }));
  /** La señal pagada con bitcoin (Señal pagada). */
  async function withDeposit() {
    const res = await booked();
    const dep = await payWithBitcoin(res.manageToken, 'DEPOSIT');
    fake.setState(dep.invoiceId, 'Settled');
    await invoices.processInvoice(A, dep.invoiceId, 'poll');
    expect(await resvOf(res.id)).toMatchObject({ status: 'DEPOSIT_PAID', paidCents: 12000 });
    return { res, walletId: dep.payment.walletId! };
  }

  it('el local anula con la factura abierta: el pago se cancela y la factura se cierra, sin «Seguir pagando»; si el bitcoin llega después, Incidencias (no a un saldo)', async () => {
    const res = await booked();
    const dep = await payWithBitcoin(res.manageToken, 'DEPOSIT');
    const out = await inCtx(A, () => ops.venueCancel(ownerActor(), res.id, 'Cerramos esa noche'));
    expect(out).toMatchObject({ saldoCents: 0, reservation: { status: 'CANCELED' } });
    expect((await statusOf(dep.payment.id)).status).toBe('CANCELED');
    expect((await rowsOf(dep.payment.id))[0]).toMatchObject({ status: 'Invalid' });
    expect((await canceledEvent(dep.payment.id))?.payload).toMatchObject({ reason: 'Reserva anulada por el local', byUserId: owner });
    expect(await inCtx(undefined, () => reservations.groupView(res.manageToken))).toMatchObject({ openPayUrl: null, payable: [] });
    await paysAnyway(dep.invoiceId, dep.payment.id);
    expect(await balanceOf(dep.payment.walletId!)).toBe(0);
    expect(await resvOf(res.id)).toMatchObject({ status: 'CANCELED', paidCents: 0, walletId: null });
  });

  it('con el bitcoin ya en la red: ni el local ni el cliente anulan (409 BITCOIN_CONFIRMING) y no se toca nada; confirmado, cuenta', async () => {
    const res = await booked();
    const dep = await payWithBitcoin(res.manageToken, 'DEPOSIT');
    fake.setState(dep.invoiceId, 'Processing');
    await invoices.processInvoice(A, dep.invoiceId, 'poll');
    await expect(inCtx(A, () => ops.venueCancel(ownerActor(), res.id, 'Cerramos'))).rejects.toMatchObject({
      response: { code: 'BITCOIN_CONFIRMING', message: expect.stringContaining('aún no se puede anular la reserva') },
    });
    await expect(inCtx(undefined, () => reservations.clientCancel(res.manageToken))).rejects.toMatchObject({
      response: { code: 'BITCOIN_CONFIRMING', message: expect.stringMatching(/^Tu pago con bitcoin ya está en la red/) },
    });
    expect(await resvOf(res.id)).toMatchObject({ status: 'PENDING', paidCents: 0 });
    expect((await statusOf(dep.payment.id)).status).toBe('AUTHORIZING');
    expect((await rowsOf(dep.payment.id))[0]).toMatchObject({ status: 'Processing' });
    fake.setState(dep.invoiceId, 'Settled');
    await invoices.processInvoice(A, dep.invoiceId, 'poll');
    expect(await resvOf(res.id)).toMatchObject({ status: 'DEPOSIT_PAID', paidCents: 12000 });
  });

  it('el cliente cancela con la factura abierta: se cancela y se cierra; con la señal pagada y el resto abierto con bitcoin, al anular (48 h) también', async () => {
    const res = await booked();
    const dep = await payWithBitcoin(res.manageToken, 'DEPOSIT');
    await inCtx(undefined, () => reservations.clientCancel(res.manageToken));
    expect(await resvOf(res.id)).toMatchObject({ status: 'CANCELED' });
    expect((await statusOf(dep.payment.id)).status).toBe('CANCELED');
    expect((await rowsOf(dep.payment.id))[0]).toMatchObject({ status: 'Invalid' });
    // Sin persona del personal: solo el porqué.
    expect((await canceledEvent(dep.payment.id))?.payload).toEqual({ type: 'CANCELED', reason: 'Reserva cancelada por el cliente' });
    expect((await inCtx(undefined, () => reservations.groupView(res.manageToken)))?.openPayUrl).toBeNull();

    const { res: paid, walletId } = await withDeposit();
    const rest = await payWithBitcoin(paid.manageToken, 'REST');
    await inCtx(undefined, () => reservations.clientCancel(paid.manageToken));
    expect(await resvOf(paid.id)).toMatchObject({ status: 'CLIENT_CANCELED', paidCents: 12000 });
    expect((await statusOf(rest.payment.id)).status).toBe('CANCELED');
    expect((await inCtx(undefined, () => reservations.groupView(paid.manageToken)))?.openPayUrl).toBeNull();
    const before = await balanceOf(walletId);
    await paysAnyway(rest.invoiceId, rest.payment.id);
    expect(await balanceOf(walletId)).toBe(before);
  });

  it('el resto en efectivo con el resto pagándose con bitcoin: en la red, no se cobra (409, y «En efectivo» lo dice antes); confirmado, ya está pagado', async () => {
    const { res, walletId } = await withDeposit();
    const rest = await payWithBitcoin(res.manageToken, 'REST');
    fake.setState(rest.invoiceId, 'Processing');
    await invoices.processInvoice(A, rest.invoiceId, 'poll');
    const confirming = 'El cliente ya pagó el resto con bitcoin y falta que la red lo confirme: no cobres en efectivo. Espera unos minutos.';
    expect((await inCtx(A, () => ops.cashQuote(ownerActor(), res.id))).blocked).toBe(confirming);
    await expect(inCtx(A, () => ops.payRestCash(ownerActor(), res.id, { key: key(), serviceFeeCents: 0 }))).rejects.toMatchObject({
      response: { code: 'RESERVATION_PAY_OPEN', message: confirming },
    });
    expect(await resvOf(res.id)).toMatchObject({ status: 'DEPOSIT_PAID', paidCents: 12000 });
    expect(await balanceOf(walletId)).toBe(12000);
    expect((await statusOf(rest.payment.id)).status).toBe('AUTHORIZING');
    fake.setState(rest.invoiceId, 'Settled');
    await invoices.processInvoice(A, rest.invoiceId, 'poll');
    expect(await resvOf(res.id)).toMatchObject({ status: 'PAID', paidCents: 40000 });
    expect(await balanceOf(walletId)).toBe(40000);
    expect((await inCtx(A, () => ops.cashQuote(ownerActor(), res.id))).blocked).toBe('Este reservado no tiene el resto pendiente');
  });

  it('el resto en efectivo con la factura del resto sin pagar: se cancela (y se cierra) y se cobra; si el bitcoin llega después, Incidencias: el resto, una sola vez', async () => {
    const { res, walletId } = await withDeposit();
    const rest = await payWithBitcoin(res.manageToken, 'REST');
    expect((await inCtx(A, () => ops.cashQuote(ownerActor(), res.id))).blocked).toBeNull();
    const view = await inCtx(A, () => ops.payRestCash(ownerActor(), res.id, { key: key(), serviceFeeCents: 0 }));
    expect(view).toMatchObject({ status: 'PAID', paidCents: 40000 });
    expect((await statusOf(rest.payment.id)).status).toBe('CANCELED');
    expect((await rowsOf(rest.payment.id))[0]).toMatchObject({ status: 'Invalid' });
    expect((await canceledEvent(rest.payment.id))?.payload).toMatchObject({ reason: 'user-canceled', byUserId: owner });
    expect(await balanceOf(walletId)).toBe(40000);
    await paysAnyway(rest.invoiceId, rest.payment.id);
    expect(await balanceOf(walletId)).toBe(40000);
    expect(await resvOf(res.id)).toMatchObject({ status: 'PAID', paidCents: 40000 });
  });

  it('el resto en efectivo con el resto en el banco con tarjeta: los primeros 2 minutos no (409); después, se cancela y se cobra', async () => {
    const { res } = await withDeposit();
    const started = await inCtx(undefined, () => reservations.startPayment(res.manageToken, 'REST', 'es'));
    const card = await sys((tx) => tx.payment.findUniqueOrThrow({ where: { qrToken: started.payToken } }));
    const order = `RC${randomUUID().slice(0, 8)}`;
    // El cliente acaba de ir a su banco con tarjeta.
    await sys(async (tx) => {
      await tx.payment.update({ where: { id: card.id }, data: { status: 'AUTHORIZING', provider: 'REDSYS', providerTxId: order } });
      await tx.paymentAttempt.create({
        data: { paymentId: card.id, tenantId: A, provider: 'REDSYS', providerTxId: order, amountCents: card.amountCents, tipCents: 0, status: 'PENDING' },
      });
    });
    const atBank = 'El cliente está pagando el resto en su banco: no cobres en efectivo. Si en 2 minutos no responde, ya podrás.';
    expect((await inCtx(A, () => ops.cashQuote(ownerActor(), res.id))).blocked).toBe(atBank);
    await expect(inCtx(A, () => ops.payRestCash(ownerActor(), res.id, { key: key(), serviceFeeCents: 0 }))).rejects.toMatchObject({
      response: { code: 'RESERVATION_PAY_OPEN', message: atBank },
    });
    expect((await statusOf(card.id)).status).toBe('AUTHORIZING');
    // Pasados 2 minutos sin respuesta del banco: se cancela (si el banco lo cobra luego, Incidencias) y se cobra en efectivo.
    await sys((tx) => tx.$executeRaw`UPDATE payment_attempts SET "createdAt" = now() - interval '3 minutes' WHERE "paymentId" = ${card.id}::uuid`);
    expect((await inCtx(A, () => ops.cashQuote(ownerActor(), res.id))).blocked).toBeNull();
    await expect(inCtx(A, () => ops.payRestCash(ownerActor(), res.id, { key: key(), serviceFeeCents: 0 }))).resolves.toMatchObject({ status: 'PAID' });
    expect((await statusOf(card.id)).status).toBe('CANCELED');
  });
});

describe('fallos pasajeros, 1 confirmación y avisos por local', () => {
  const stale = (invoiceId: string) =>
    sys((tx) => tx.$executeRaw`UPDATE btcpay_invoices SET "lastCheckedAt" = now() - interval '10 minutes' WHERE "invoiceId" = ${invoiceId}`);

  it('las facturas se crean con MediumSpeed (1 confirmación): nunca 0-conf', async () => {
    const p = await newPayment(2900);
    await startFor(p.token);
    expect((fake.lastCreate as { checkout: { speedPolicy: string } }).checkout.speedPolicy).toBe('MediumSpeed');
  });

  it('si dar el cobro por pagado falla con un error que no es de la máquina, la factura sigue abierta y el siguiente repaso lo apunta', async () => {
    const p = await newPayment(2800);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.setState(res.view.invoiceId, 'Settled');
    await stale(res.view.invoiceId);
    const spy = vi.spyOn(payments, 'transition').mockRejectedValueOnce(new Error('blip de la base'));
    expect(await invoices.pollForToken(p.token)).toMatchObject({ state: 'open' });
    spy.mockRestore();
    expect((await rowsOf(p.id))[0]).toMatchObject({ closedAt: null });
    expect((await statusOf(p.id)).status).toBe('AUTHORIZING');
    await stale(res.view.invoiceId);
    expect(await invoices.pollForToken(p.token)).toEqual({ state: 'paid' });
    expect((await statusOf(p.id)).status).toBe('AUTHORIZED');
    expect((await rowsOf(p.id))[0]).toMatchObject({ status: 'Settled' });
  });

  it('lo mismo al reabrir una factura caducada: si falla, no se cierra la fila y el siguiente repaso reabre el cobro', async () => {
    const p = await newPayment(2810);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.setState(res.view.invoiceId, 'Expired');
    await stale(res.view.invoiceId);
    const spy = vi.spyOn(payments, 'transition').mockRejectedValueOnce(new Error('blip de la base'));
    await invoices.pollForToken(p.token);
    spy.mockRestore();
    expect((await rowsOf(p.id))[0]).toMatchObject({ closedAt: null });
    await stale(res.view.invoiceId);
    await invoices.pollForToken(p.token);
    expect((await statusOf(p.id)).status).toBe('AWAITING_CAPTURE');
  });

  it('Settled marcada a mano en BTCPay (Marked): incidencia, nunca «Pagado»', async () => {
    const p = await newPayment(2820);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.setState(res.view.invoiceId, 'Settled', 'Marked');
    await invoices.processInvoice(A, res.view.invoiceId, 'poll');
    expect((await statusOf(p.id)).status).toBe('AUTHORIZING');
    const ev = await sys((tx) => tx.paymentEvent.findMany({ where: { paymentId: p.id, eventType: 'payment.approval_unverified' } }));
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ reason: 'btcpay-marked', source: 'btcpay' });
  });

  it('una factura Processing (pago en la red, falta 1 confirmación) mantiene el cobro vivo pasados los 15 min y el repaso la sigue mirando', async () => {
    const p = await newPayment(2830);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.setState(res.view.invoiceId, 'Processing');
    await sys((tx) => tx.$executeRaw`UPDATE btcpay_invoices SET "expiresAt" = now() - interval '2 hours' WHERE "invoiceId" = ${res.view.invoiceId}`);
    await stale(res.view.invoiceId);
    await invoices.sweepOpen();
    expect((await rowsOf(p.id))[0]).toMatchObject({ status: 'Processing', closedAt: null });
    expect((await statusOf(p.id)).status).toBe('AUTHORIZING');
    // Sigue abierta para la pantalla (no se abre otra factura) y sigue en «Processing».
    const again = await startFor(p.token);
    expect(again.kind === 'invoice' && again.view.invoiceId).toBe(res.view.invoiceId);
    expect(await invoices.pollForToken(p.token)).toMatchObject({ state: 'open', status: 'Processing' });
    // Al confirmarse la red, el repaso lo da por pagado.
    fake.setState(res.view.invoiceId, 'Settled');
    await stale(res.view.invoiceId);
    await invoices.sweepOpen();
    expect((await statusOf(p.id)).status).toBe('AUTHORIZED');
  });

  it('el mismo deliveryId de dos locales se procesa en los dos (la clave de avisos va acotada al local)', async () => {
    const { sealBtcpaySecret } = await import('../../src/modules/btcpay/btcpay-secrets');
    const secretB = 'secreto-del-local-b-0123456789abcdef';
    await sys((tx) =>
      tx.btcpayStore.create({
        data: {
          tenantId: B, baseUrl: 'https://btcpay.sala-test.es', storeId: 'STORE1', apiKeyEnc: sealBtcpaySecret(KEK, B, 'apikey', fake.apiKey),
          webhookSecretEnc: sealBtcpaySecret(KEK, B, 'webhook', secretB), hookToken: `hk-b-${r}-0123456789abcdefghij`, enabled: true,
        },
      }),
    );
    const event = { type: 'InvoiceSettled', deliveryId: `igual-${r}`, originalDeliveryId: `orig-igual-${r}`, storeId: 'STORE1', invoiceId: 'DESCONOCIDA' };
    const bodyA = Buffer.from(JSON.stringify(event), 'utf8');
    const { secret, token } = await secretOf(A);
    hookQueue.add.mockClear();
    expect(await hookController.receive(token, sign(secret, bodyA), { rawBody: bodyA } as never)).toEqual({ received: true });
    expect(await hookController.receive(`hk-b-${r}-0123456789abcdefghij`, sign(secretB, bodyA), { rawBody: bodyA } as never)).toEqual({ received: true });
    expect(hookQueue.add).toHaveBeenCalledTimes(2);
    const rows = await sys((tx) => tx.webhookDelivery.findMany({ where: { provider: 'BTCPAY', externalEventId: { endsWith: `:orig-igual-${r}` } } }));
    expect(rows.map((x) => x.tenantId).sort()).toEqual([A, B].sort());
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
    // (B puede tener su propia conexión por otras pruebas; nunca la de A.)
    expect((await stores.accessFor(B))?.tenantId ?? B).toBe(B);
    const seen = await inCtx(B, () => prisma.withTenant(B, (tx) => tx.btcpayStore.findMany()));
    expect(seen.every((x) => x.tenantId === B)).toBe(true);
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
  it('lo pagado con bitcoin NO ofrece «Devolución BBVA» ni devolución por la pasarela: 409 con su código (solo en euros)', async () => {
    const p = await newPayment(1700);
    const res = await startFor(p.token);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    fake.setState(res.view.invoiceId, 'Settled');
    await invoices.processInvoice(A, res.view.invoiceId, 'poll');
    expect((await statusOf(p.id)).status).toBe('AUTHORIZED');
    const actor = { userId: owner, role: 'OWNER', tenantId: A } as never;
    // Es una carga de saldo: el saldo no se devuelve (se mira antes que el bitcoin).
    for (const tryIt of [() => refunds.registerBankRefund({ paymentId: p.id, amountCents: 500, reason: 'prueba' } as never, actor), () => refunds.refund({ paymentId: p.id, amountCents: 500, reason: 'prueba' } as never, actor)]) {
      await expect(inCtx(A, tryIt)).rejects.toMatchObject({ response: { code: 'SALDO_NO_SE_DEVUELVE' } });
    }
    // Un cobro de la barra pagado con bitcoin (de antes de «solo al cargar saldo»): 409 con su código, solo en euros.
    await sys((tx) => tx.payment.update({ where: { id: p.id }, data: { walletId: null } }));
    await expect(inCtx(A, () => refunds.registerBankRefund({ paymentId: p.id, amountCents: 500, reason: 'prueba' } as never, actor))).rejects.toMatchObject({
      response: { code: 'BITCOIN_REFUND_NOT_AVAILABLE' },
    });
    const viaGateway = await inCtx(A, () => refunds.refund({ paymentId: p.id, amountCents: 500, reason: 'prueba' } as never, actor)).catch((e: unknown) => e);
    expect(viaGateway).toMatchObject({ response: { code: 'BITCOIN_REFUND_NOT_AVAILABLE' } });
    // Regla del dueño: nunca en bitcoin, solo en euros.
    expect((viaGateway as { response: { message: string } }).response.message).toMatch(/solo en euros/);
    expect(await sys((tx) => tx.refund.count({ where: { paymentId: p.id } }))).toBe(0);
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

  it('con la «Comisión del servicio» del local: un cobro de la barra (como el C-0049) ya no se paga con bitcoin; una carga de 1,00 € + 0,10 € sí: la factura es de 1,10 €, BTCPay la da por pagada («1.1») y el repaso, sin aviso, la apunta; la comisión, de OxioPay', async () => {
    const { sealBtcpaySecret } = await import('../../src/modules/btcpay/btcpay-secrets');
    const F = await sys(async (tx) => {
      const id = (await tx.venue.create({ data: { name: 'Sala Comisión BTC', slug: `btc-f-${r}`, walletGroup: `gbtc-f-${r}`, serviceFeeEnabled: true, serviceFeeBps: 1000 } })).id;
      const own = (await tx.user.create({ data: { tenantId: id, email: `own-f-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
      const wai = (await tx.user.create({ data: { tenantId: id, email: `wai-f-${r}@x.es`, passwordHash: 'x', role: 'WAITER' } })).id;
      await tx.terminal.create({ data: { tenantId: id, externalId: `BTCF-${r}`, label: 'Copas', zone: 'BARRA' } });
      await tx.venueNight.create({ data: { tenantId: id, openedAt: new Date(Date.now() - 2 * 3_600_000), openingFloatCents: 0, openedBy: own } });
      await tx.btcpayStore.create({
        data: {
          tenantId: id, baseUrl: 'https://btcpay.sala-test.es', storeId: fake.storeId, apiKeyEnc: sealBtcpaySecret(KEK, id, 'apikey', fake.apiKey),
          webhookSecretEnc: sealBtcpaySecret(KEK, id, 'webhook', 'secreto-comision-0123456789abcdef'), hookToken: `hk-f-${r}-0123456789abcdefghij`, enabled: true, lastCheckOk: true,
        },
      });
      return { id, wai, own };
    });
    // El cobro de la barra (C-0049): la comisión la pone el servidor, pero bitcoin ya no se ofrece.
    const barra = await inCtx(F.id, () =>
      payments.create(F.id, key(), { currency: 'EUR', terminalExternalId: `BTCF-${r}`, amountCents: 100 } as never, { userId: F.wai, role: 'WAITER' }),
    );
    expect(barra).toMatchObject({ amountCents: 100, serviceFeeCents: 10 });
    await expect(startFor(barra.qrToken)).rejects.toMatchObject({ response: { code: 'BTCPAY_NOT_OFFERED' } });
    // Una carga de saldo con QR (recepción): la comisión de las cargas la pone el servidor.
    const created = await inCtx(F.id, () =>
      payments.create(F.id, key(), { currency: 'EUR', terminalExternalId: `BTCF-${r}`, amountCents: 100, wallet: { create: true } } as never, { userId: F.own, role: 'OWNER' }),
    );
    expect(created).toMatchObject({ amountCents: 100, serviceFeeCents: 10 });
    const res = await startFor(created.qrToken);
    if (res.kind !== 'invoice') throw new Error('sin factura');
    // La factura es lo mismo que pagaría con tarjeta: importe + comisión (1,10 €).
    expect(res.view.amountCents).toBe(110);
    const inv = fake.invoices.get(res.view.invoiceId)!;
    expect(inv.amount).toBe('1.10');
    // BTCPay puede devolver el importe sin el cero del final: sigue cuadrando.
    inv.amount = '1.1';
    fake.setState(inv.id, 'Settled');
    await sweepUntil(inv.id, async () => (await statusOf(created.id)).status === 'AUTHORIZED');
    expect(await statusOf(created.id)).toMatchObject({
      // En una carga, la comisión no se devuelve: lo devolvible es el saldo (1 €).
      status: 'AUTHORIZED', provider: 'BTCPAY', providerTxId: inv.id, amountCents: 100, serviceFeeCents: 10, tipCents: 0, availableAmountCents: 100,
    });
    // Al saldo va 1 € (la comisión no es saldo).
    expect((await sys((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: created.walletId! } }))).balanceCents).toBe(100);
    expect(await sys((tx) => tx.paymentAttempt.findMany({ where: { paymentId: created.id } }))).toEqual([
      expect.objectContaining({ provider: 'BTCPAY', providerTxId: inv.id, amountCents: 110, status: 'APPROVED', payMethod: 'bitcoin' }),
    ]);
    expect((await rowsOf(created.id))[0]).toMatchObject({ status: 'Settled', amountCents: 110 });
    expect((await rowsOf(created.id))[0]?.closedAt).toBeTruthy();
    const events = await sys((tx) => tx.paymentEvent.findMany({ where: { paymentId: created.id } }));
    expect(events.filter((e) => e.eventType.startsWith('payment.approval'))).toHaveLength(0);
    // El reparto: 1 € de saldo cargado con bitcoin (no es venta); los 0,10 € de comisión son de OxioPay (están en la cartera del local).
    const map = await moneyMap.forQuery(F.id, { night: 'current' } as never, new Date(Date.now() + 1_000));
    expect(map.salesCents).toBe(0);
    expect(map.inflow.topUps).toMatchObject({ totalCents: 100, bitcoinCents: 100, count: 1 });
    expect(map.where.bitcoinCents).toBe(110);
    expect(map.where.owners).toMatchObject({ saldoCents: 100, oxioPayCents: 10 });
    expect(map.serviceFee).toMatchObject({ salesCents: 0, topUpsCents: 10, owedCents: 10 });
  });
});

describe('las migraciones de bitcoin', () => {
  const dir = join(__dirname, '../../../../packages/db/prisma/migrations');
  const sqlOf = (name: string) => readFileSync(join(dir, name, 'migration.sql'), 'utf8');
  const statements = (sql: string) =>
    sql
      .split(';')
      .map((chunk) =>
        chunk
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join(' ')
          .trim(),
      )
      .filter((st) => st.length > 0);

  it.each(['20261114100000_btcpay', '20261114100100_btcpay_tablas'])('%s: con su lock_timeout y sin tocar migraciones de antes', (name) => {
    expect(sqlOf(name)).toMatch(/SET lock_timeout = '5s'/);
    expect(sqlOf(name)).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM/i);
  });

  it('el valor del enum va en su propia migración (no se puede usar en la misma transacción que lo crea)', () => {
    const enumSql = sqlOf('20261114100000_btcpay');
    expect(enumSql).toMatch(/ADD VALUE IF NOT EXISTS 'BTCPAY'/);
    expect(sqlOf('20261114100100_btcpay_tablas')).not.toMatch(/ADD VALUE/);
    expect(statements(enumSql).filter((st) => !st.startsWith('SET'))).toHaveLength(1);
  });

  it('se pueden repetir: volver a aplicarlas no falla ni cambia nada', async () => {
    const before = await sys((tx) => tx.btcpayStore.count());
    for (const name of ['20261114100000_btcpay', '20261114100100_btcpay_tablas']) {
      for (const st of statements(sqlOf(name))) await sys((tx) => tx.$executeRawUnsafe(st));
    }
    expect(await sys((tx) => tx.btcpayStore.count())).toBe(before);
    await sys((tx) => tx.$executeRawUnsafe('RESET lock_timeout'));
  });

  it('los CHECK: un uso o un estado inventado, o un importe a cero, no entran', async () => {
    await expect(
      sys((tx) => tx.btcpayStore.create({ data: { tenantId: B, baseUrl: 'https://x.es', storeId: 's', apiKeyEnc: 'a:b:c', hookToken: `hk-chk-${r}-abcdefghijklmnop`, purpose: 'TODO' } })),
    ).rejects.toThrow();
    const p = await newPayment(500);
    const base = { tenantId: A, paymentId: p.id, storeId: 'S', checkoutLink: 'https://x', qrLink: 'bitcoin:x', expiresAt: new Date(Date.now() + 60_000) };
    await expect(sys((tx) => tx.btcpayInvoice.create({ data: { ...base, invoiceId: `chk1-${r}`, amountCents: 0 } }))).rejects.toThrow();
    await expect(sys((tx) => tx.btcpayInvoice.create({ data: { ...base, invoiceId: `chk2-${r}`, amountCents: 500, status: 'Rara' } }))).rejects.toThrow();
  });

  it('los datos de un local no se borran con otro: la conexión y las facturas caen con su local, no con el cobro de otro', async () => {
    const L = await sys(async (tx) => (await tx.venue.create({ data: { name: 'Sala Borrable', slug: `btc-del-${r}`, walletGroup: `gbtc-del-${r}` } })).id);
    await sys((tx) => tx.btcpayStore.create({ data: { tenantId: L, baseUrl: 'https://x.es', storeId: 's', apiKeyEnc: 'a:b:c', hookToken: `hk-del-${r}-abcdefghijklmnop` } }));
    await sys((tx) => tx.venue.delete({ where: { id: L } }));
    expect(await sys((tx) => tx.btcpayStore.count({ where: { tenantId: L } }))).toBe(0);
  });
});
