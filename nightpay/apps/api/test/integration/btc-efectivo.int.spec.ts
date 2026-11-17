// Integración (Postgres real, np_app con FORCE RLS): devolver en efectivo lo
// pagado con bitcoin. Un cobro pagado con bitcoin (directo por el dueño, y
// pedido por el encargado: el dueño aprueba con su 2FA y el encargado pulsa
// «Entregado»), el bitcoin que llegó sin cobro (una vez por factura), el
// interruptor del local y lo que sale de la caja. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { confirmationCode, type BitcoinCashRefundDto } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { PeanpeAdapter } from '../../src/modules/gateways/peanpe.adapter';
import { ApprovalRequestsService, type ApprovalActor } from '../../src/modules/approvals/approval-requests.service';
import { ApprovalsService } from '../../src/modules/approvals/approvals.service';
import { TotpService } from '../../src/modules/auth/totp.service';
import { CLAIM_STEP_LUA, TotpAttemptsService } from '../../src/modules/auth/totp-attempts.service';
import { LockoutService } from '../../src/modules/auth/lockout.service';
import { claimStepScript, createFakeRedis } from '../../src/modules/auth/testing/fake-redis';
import { totpCodeAt } from '../../src/modules/auth/testing/totp-kit';
import { BitcoinCashService } from '../../src/modules/bitcoin-cash/bitcoin-cash.service';
import { bitcoinCashOut } from '../../src/modules/bitcoin-cash/bitcoin-cash-rows';
import { CloseCheckService } from '../../src/modules/nights/close-check.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { CobroDetailService } from '../../src/modules/money-map/cobro-detail.service';

process.env.BTCPAY_ENABLED = 'true';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const auditLog: Array<{ action: string; payload?: Record<string, unknown> | null }> = [];
const audit = { log: async (e: (typeof auditLog)[number]) => void auditLog.push(e) };
const config = { get: () => undefined, getOrThrow: () => 'x' };
const gatewayMetrics = { gatewayDuration: { observe: vi.fn() }, circuitState: { set: vi.fn() } };
const redis = createFakeRedis();
redis.defineScript(CLAIM_STEP_LUA, claimStepScript);
const totp = new TotpService(prisma, new TotpAttemptsService(new LockoutService(redis as never), redis as never));
const queue = { add: vi.fn(async () => undefined) };
const payments = new PaymentsService(
  prisma,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  { emitPaymentUpdate: vi.fn(), emitPaymentCompleted: vi.fn() } as never,
  { paymentsTransitioned: { inc: vi.fn() }, walletCreditSkipped: { inc: vi.fn() } } as never,
  new PeanpeAdapter(config as never, gatewayMetrics as never, prisma),
  {} as never,
);
const notifier = { enabled: () => false, requested: vi.fn() };
const requests = new ApprovalRequestsService(prisma, audit as never, config as never, notifier as never);
const approvals = new ApprovalsService(prisma, requests, {} as never, {} as never, totp, audit as never);
// Telegram de mentira: cada devolución en efectivo manda su aviso.
const telegram = { hasBot: () => true, isConfigured: () => true, send: vi.fn(async (_text: string) => true) };
const sent = () => telegram.send.mock.calls.map((c) => c[0]);
const cash = new BitcoinCashService(prisma, payments, totp, audit as never, requests, telegram as never);
const checks = new CloseCheckService(prisma, {} as never, config as never);
const details = new CobroDetailService(prisma, undefined, { get: () => undefined } as never);

function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: `t-btc-${tenantId.slice(0, 4)}`, tenantId });
    return fn();
  });
}
const sys = <T>(fn: Parameters<PrismaService['asSystem']>[0]) =>
  cls.run(async () => {
    cls.set('ctx', { traceId: 't-btc' });
    return prisma.asSystem(fn);
  }) as Promise<T>;

async function failure(p: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof HttpException)) throw new Error(`se esperaba un error HTTP y llegó ${String(err)}`);
  const body = err.getResponse();
  return { status: err.getStatus(), body: typeof body === 'string' ? { message: body } : (body as Record<string, unknown>) };
}

const r = randomUUID().slice(0, 6);
const HOUR = 60 * 60 * 1000;
let seq = 0;
const uniq = (p: string) => `${p}-${r}-${++seq}`;
const secrets = new Map<string, string>();
let V: string;
let term: string;
let storeId: string;
const startedAt = new Date(Date.now() - HOUR / 2);

async function newUser(role: 'OWNER' | 'MANAGER'): Promise<ApprovalActor> {
  const secret = totp.newSecret();
  const id = await sys<string>(async (tx) =>
    (await tx.user.create({ data: { tenantId: V, email: `${uniq(role.toLowerCase())}@x.es`, passwordHash: 'x', role, displayName: role, totpSecret: totp.sealSecret(secret) } })).id,
  );
  secrets.set(id, secret);
  return { userId: id, role, tenantId: V };
}
const codeOf = (a: ApprovalActor) => totpCodeAt(secrets.get(a.userId)!);

/** Un cobro y su factura de BTCPay (pagada o no). */
async function newBitcoinPayment(o: { amountCents: number; status: string; invoice: { status: string; paidCents?: number } }) {
  const invoiceId = `INV${randomUUID().replace(/-/g, '').slice(0, 18)}`;
  const paymentId = await sys<string>(async (tx) => {
    const p = await tx.payment.create({
      data: {
        tenantId: V, terminalId: term, idempotencyKey: uniq('k'), qrToken: uniq('q'), qrExpiresAt: new Date(Date.now() + HOUR),
        status: o.status, provider: 'BTCPAY', providerTxId: invoiceId, amountCents: o.amountCents,
        availableAmountCents: o.status === 'AUTHORIZED' ? o.amountCents : 0, revenueCategory: 'VENUE_BAR',
        authorizedAt: o.status === 'AUTHORIZED' ? new Date(Date.now() - HOUR) : null,
      } as never,
    });
    await tx.btcpayInvoice.create({
      data: {
        tenantId: V, paymentId: p.id, invoiceId, storeId, amountCents: o.amountCents, status: o.invoice.status,
        ...(o.invoice.paidCents !== undefined ? { paidCents: o.invoice.paidCents } : {}),
        checkoutLink: 'https://pay.ejemplo.es/i/x', qrLink: 'bitcoin:bc1qx?amount=0.001', expiresAt: new Date(Date.now() - HOUR / 4),
        closedAt: new Date(Date.now() - HOUR / 4),
      },
    });
    return p.id;
  });
  return { paymentId, invoiceId };
}

const body = (o: Partial<BitcoinCashRefundDto> & Pick<BitcoinCashRefundDto, 'amountCents' | 'receiptCode'>): BitcoinCashRefundDto => ({ reason: 'WRONG_CHARGE', ...o });
const paymentOf = (id: string) => sys<{ status: string; availableAmountCents: number }>((tx) => tx.payment.findUniqueOrThrow({ where: { id } }));

beforeAll(async () => {
  await prisma.onModuleInit();
  ({ V, term, storeId } = await sys<{ V: string; term: string; storeId: string }>(async (tx) => {
    const v = await tx.venue.create({ data: { name: `Btc efectivo ${r}`, slug: `btc-efectivo-${r}` } });
    const t = await tx.terminal.create({ data: { tenantId: v.id, externalId: `BTC-${r}`, label: 'Barra' } });
    const s = await tx.btcpayStore.create({
      data: { tenantId: v.id, baseUrl: 'https://pay.ejemplo.es', storeId: `st${r}`, apiKeyEnc: 'x:y:z', hookToken: `hk-${r}`, enabled: true, cashRefundEnabled: true },
    });
    return { V: v.id, term: t.id, storeId: s.storeId };
  }));
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('devolver en efectivo un cobro pagado con bitcoin', () => {
  it('el dueño, con su 2FA y el código del recibo: sale de la caja, baja lo devolvible y queda «en efectivo»', async () => {
    const owner = await newUser('OWNER');
    const { paymentId } = await newBitcoinPayment({ amountCents: 5_000, status: 'AUTHORIZED', invoice: { status: 'Settled' } });
    // Sin el código del recibo del cliente, no.
    expect((await failure(asStaff(V, () => cash.refundPayment(owner, paymentId, body({ amountCents: 2_000, receiptCode: 'ZZZ', totpCode: codeOf(owner) }))))).status).toBe(400);
    const done = await asStaff(V, () => cash.refundPayment(owner, paymentId, body({ amountCents: 2_000, receiptCode: confirmationCode(paymentId), totpCode: codeOf(owner) })));
    expect(done).toMatchObject({ kind: 'done', amountCents: 2_000 });
    expect(await paymentOf(paymentId)).toMatchObject({ status: 'PARTIALLY_REFUNDED', availableAmountCents: 3_000 });
    const refund = await asStaff(V, () => prisma.withTenant(V, (tx) => tx.refund.findFirstOrThrow({ where: { paymentId } })));
    expect(refund).toMatchObject({ paidInCash: true, status: 'SUCCEEDED', amountCents: 2_000, receiptCode: confirmationCode(paymentId) });
    // El detalle del cobro (y su ticket) dice «Devuelto en efectivo», no «a la tarjeta».
    const me = { sub: owner.userId, role: 'OWNER', tenantId: V } as never;
    const detail = await asStaff(V, () => details.forManager(me, 'PAYMENT', paymentId));
    expect(detail.undo).toEqual([expect.objectContaining({ kind: 'REFUND', amountCents: 2_000, paidInCash: true })]);
    expect(auditLog.some((e) => e.action === 'refund.cash_registered')).toBe(true);
    // El aviso por Telegram: quién, cuánto, el motivo y el cobro; sin el código del recibo del cliente.
    await vi.waitFor(() => expect(sent().some((t) => t.includes('20,00 € de la caja · Cobro') && t.includes('Motivo: Cobro equivocado'))).toBe(true));
    expect(sent().join(' | ')).not.toContain(confirmationCode(paymentId));
  });

  it('el encargado, de más de 100 €: lo pide al dueño; el dueño aprueba (no sale nada) y al pulsar «Entregado» se apunta, una sola vez', async () => {
    const manager = await newUser('MANAGER');
    const owner = await newUser('OWNER');
    const { paymentId, invoiceId } = await newBitcoinPayment({ amountCents: 15_000, status: 'AUTHORIZED', invoice: { status: 'Settled' } });
    const asked = await asStaff(V, () => cash.refundPayment(manager, paymentId, body({ amountCents: 12_000, receiptCode: invoiceId.slice(3, 12) })));
    expect(asked).toMatchObject({ status: 'PENDING', kind: 'REFUND', amountCents: 12_000 });
    const approvalId = (asked as { approvalRequestId: string }).approvalRequestId;
    // Mientras está pedido, reserva: otra devolución que no cabe, no.
    expect((await failure(asStaff(V, () => cash.refundPayment(owner, paymentId, body({ amountCents: 5_000, receiptCode: confirmationCode(paymentId), totpCode: codeOf(owner) }))))).status).toBe(409);

    const approver = await newUser('OWNER');
    const view = await asStaff(V, () => approvals.approve(approver, approvalId, codeOf(approver)));
    expect(view).toMatchObject({ status: 'APPROVED', resultRef: null, kind: 'REFUND', refund: { cash: { source: 'payment', handed: false } } });
    expect(await paymentOf(paymentId)).toMatchObject({ status: 'AUTHORIZED', availableAmountCents: 15_000 });

    const handed = await asStaff(V, () => cash.handOver(manager, approvalId));
    expect(handed).toMatchObject({ kind: 'done', amountCents: 12_000 });
    expect(await paymentOf(paymentId)).toMatchObject({ status: 'PARTIALLY_REFUNDED', availableAmountCents: 3_000 });
    const again = await asStaff(V, () => cash.handOver(manager, approvalId));
    expect(again).toMatchObject({ id: handed.id, message: 'Ya estaba apuntada como entregada.' });
    const refunds = await asStaff(V, () => prisma.withTenant(V, (tx) => tx.refund.count({ where: { paymentId } })));
    expect(refunds).toBe(1);
    // Pasaba de 100 €: el aviso dice también quién la aprobó.
    await vi.waitFor(() => expect(sent().some((t) => t.includes('120,00 € de la caja') && t.includes('la aprobó'))).toBe(true));
  });
});

describe('el bitcoin que llegó sin cobro', () => {
  it('a un cobro cancelado: se devuelve lo que llegó, una sola vez por factura', async () => {
    const owner = await newUser('OWNER');
    const owner2 = await newUser('OWNER');
    const { invoiceId } = await newBitcoinPayment({ amountCents: 4_000, status: 'CANCELED', invoice: { status: 'Settled', paidCents: 4_000 } });
    // Más de lo que llegó, no.
    expect((await failure(asStaff(V, () => cash.returnInvoice(owner, invoiceId, body({ amountCents: 4_001, receiptCode: invoiceId, totpCode: codeOf(owner) }))))).status).toBe(409);
    const done = await asStaff(V, () => cash.returnInvoice(owner, invoiceId, body({ amountCents: 4_000, reason: 'CHARGED_TWICE', receiptCode: invoiceId.slice(-8), totpCode: codeOf(owner) })));
    expect(done).toMatchObject({ kind: 'done', amountCents: 4_000 });
    await vi.waitFor(() => expect(sent().some((t) => t.includes(`Bitcoin sin cobro (factura ${invoiceId})`))).toBe(true));
    const again = await failure(asStaff(V, () => cash.returnInvoice(owner2, invoiceId, body({ amountCents: 1_000, receiptCode: invoiceId, totpCode: codeOf(owner2) }))));
    expect(again).toMatchObject({ status: 409, body: { message: expect.stringContaining('ya se devolvió') } });
  });

  it('el bitcoin que pagó el cobro no se devuelve como «sin cobro» (ni lo pagado de más)', async () => {
    const owner = await newUser('OWNER');
    const { invoiceId } = await newBitcoinPayment({ amountCents: 3_000, status: 'AUTHORIZED', invoice: { status: 'Settled', paidCents: 3_500 } });
    const res = await failure(asStaff(V, () => cash.returnInvoice(owner, invoiceId, body({ amountCents: 500, receiptCode: invoiceId, totpCode: codeOf(owner) }))));
    expect(res).toMatchObject({ status: 409, body: { message: expect.stringContaining('pagó el cobro') } });
  });
});

describe('«Me voy» con saldo cargado con bitcoin', () => {
  it('el aviso separa la parte de bitcoin (se queda como saldo); si todo es bitcoin, no sale', async () => {
    const incidents = new IncidentsService(prisma, audit as never);
    const wallets = await sys<{ mixed: string; onlyBtc: string }>(async (tx) => {
      const mk = async (tag: string, balanceCents: number, topUps: Array<{ provider: 'BTCPAY' | 'REDSYS'; cents: number }>) => {
        const w = await tx.clientWallet.create({ data: { tenantId: V, balanceCents, qrToken: uniq(`w-${tag}`), closeRequestedAt: new Date() } as never });
        for (const t of topUps) {
          await tx.payment.create({
            data: {
              tenantId: V, terminalId: term, idempotencyKey: uniq('k'), qrToken: uniq('q'), qrExpiresAt: new Date(Date.now() + HOUR),
              status: 'AUTHORIZED', provider: t.provider, providerTxId: uniq('TX'), amountCents: t.cents, availableAmountCents: t.cents,
              walletId: w.id, revenueCategory: 'VENUE_BAR', authorizedAt: new Date(),
            } as never,
          });
        }
        return w.id;
      };
      return {
        mixed: await mk('mix', 8_000, [{ provider: 'REDSYS', cents: 5_000 }, { provider: 'BTCPAY', cents: 3_000 }]),
        onlyBtc: await mk('btc', 2_000, [{ provider: 'BTCPAY', cents: 2_000 }]),
      };
    });
    const items = await asStaff(V, () => incidents.list(V));
    const closing = items.filter((i) => i.kind === 'wallet_close_requested');
    const mixed = closing.find((i) => i.refId === wallets.mixed);
    expect(mixed).toMatchObject({ amountCents: 5_000 });
    expect(mixed!.detail).toContain('Los otros 30,00 €: esta parte entró con bitcoin: se queda como saldo para otra noche, no se devuelve.');
    expect(closing.some((i) => i.refId === wallets.onlyBtc)).toBe(false);
  });
});

describe('caja e interruptor', () => {
  it('lo devuelto en efectivo sale de la caja de la noche (arqueo)', async () => {
    const window = { from: startedAt, to: new Date(Date.now() + 60_000) };
    const out = await asStaff(V, () => prisma.withTenant(V, (tx) => bitcoinCashOut(tx, V, window)));
    expect(out).toEqual({ count: 3, cents: 2_000 + 12_000 + 4_000 });
    const nightCash = await asStaff(V, () => checks.cash(V, window, 0));
    expect(nightCash).toMatchObject({ bitcoinCashOutCount: 3, bitcoinCashOutCents: 18_000, cashOutCents: 18_000, expectedCents: -18_000 });
  });

  it('con el interruptor del local apagado, nada', async () => {
    const owner = await newUser('OWNER');
    await sys((tx) => tx.btcpayStore.update({ where: { tenantId: V }, data: { cashRefundEnabled: false } }));
    const { paymentId } = await newBitcoinPayment({ amountCents: 1_000, status: 'AUTHORIZED', invoice: { status: 'Settled' } });
    const res = await failure(asStaff(V, () => cash.refundPayment(owner, paymentId, body({ amountCents: 500, receiptCode: confirmationCode(paymentId), totpCode: codeOf(owner) }))));
    expect(res).toMatchObject({ status: 409, body: { code: 'BITCOIN_CASH_OFF' } });
    expect(await asStaff(V, () => cash.config(owner))).toMatchObject({ enabled: false });
  });
});
