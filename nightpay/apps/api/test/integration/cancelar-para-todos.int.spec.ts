// Integración (Postgres real, RLS forzado): «Cancelar cobro» para todo el personal y el pago que llega después. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import type { Job } from 'bullmq';
import { serializeAndSignJSONRequest } from 'redsys-easy';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { RedsysAdapter } from '../../src/modules/gateways/redsys.adapter';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { AlertsService } from '../../src/modules/incidents/alerts.service';
import { WebhookIngestProcessor } from '../../src/modules/queues/webhook-ingest.processor';
import { listUnpaidCobros } from '../../src/modules/payments/unpaid-cobros';
import { renderResultView } from '../../src/modules/payments/public-pay.pages';
import { AcceptAfterCancelController } from '../../src/modules/admin/accept-after-cancel.controller';
import { TotpService } from '../../src/modules/auth/totp.service';
import { CLAIM_STEP_LUA, TotpAttemptsService } from '../../src/modules/auth/totp-attempts.service';
import { LockoutService } from '../../src/modules/auth/lockout.service';
import { claimStepScript, createFakeRedis } from '../../src/modules/auth/testing/fake-redis';
import { totpCodeAt } from '../../src/modules/auth/testing/totp-kit';
import { posReference } from '../../src/modules/pos-device/paytef';
import { PosDeviceService } from '../../src/modules/pos-device/pos-device.service';
import { PosDeviceReceptionService } from '../../src/modules/pos-device/pos-device-reception.service';
import { PaytefDeviceSaleProver } from '../../src/modules/pos-device/pos-sale-proof';
import { CashTopUpService } from '../../src/modules/wallets/wallet-cash-topup.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const noop = () => undefined;
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  {} as never,
  {} as never,
  {} as never,
  { emitPaymentUpdate: noop, emitPaymentCompleted: noop } as never,
  { paymentsTransitioned: { inc: noop }, walletCreditSkipped: { inc: noop } } as never,
  {} as never,
  {} as never,
  {} as never,
);
const SECRET = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';
const MERCHANT = '999008881';
const config = {
  get: (k: string) =>
    ({ REDSYS_MERCHANT_CODE: MERCHANT, REDSYS_TERMINAL: '1', REDSYS_SECRET_KEY: SECRET, REDSYS_API_URL: 'https://sis-t.redsys.es:25443/sis/realizarPago' })[k],
};
const redsys = new RedsysAdapter(config as never, { gatewayDuration: { observe: noop }, circuitState: { set: noop } } as never);
// Si alguien intentara devolverlo solo, se vería aquí.
const refund = vi.spyOn(redsys, 'refund');
const processor = new WebhookIngestProcessor(prisma as never, payments as never, { get: () => redsys } as never);
const auditLog: Array<{ action: string; payload?: Record<string, unknown> | null }> = [];
const audit = { log: async (e: (typeof auditLog)[number]) => void auditLog.push(e) };
const incidents = new IncidentsService(prisma as never, audit as never);
// Telegram y Redis de mentira para la vuelta de avisos (cada incidencia una vez).
const telegram = { isConfigured: () => true, send: vi.fn(async (_text: string) => true) };
const marks = new Map<string, string>();
const alertsRedis = {
  set: async (k: string, v: string, ..._o: unknown[]) => (marks.has(k) ? null : (marks.set(k, v), 'OK')),
  del: async (k: string) => Number(marks.delete(k)),
  exists: async (k: string) => Number(marks.has(k)),
};
const alerts = new AlertsService(prisma as never, alertsRedis as never, incidents, {} as never, telegram as never);
const totpRedis = createFakeRedis();
totpRedis.defineScript(CLAIM_STEP_LUA, claimStepScript);
const totp = new TotpService(prisma, new TotpAttemptsService(new LockoutService(totpRedis as never), totpRedis as never));
const accept = new AcceptAfterCancelController(prisma, payments, totp, audit as never);
// La recepción del datáfono (PAX), como en producción: Paytef no deja comprobar
// la venta desde el servidor, así que la recarga con tarjeta queda «sin comprobar».
const paxQueue = { add: vi.fn(async () => undefined) };
const paxPayments = new PaymentsService(
  prisma as never,
  cls as never,
  paxQueue as never,
  paxQueue as never,
  {} as never,
  { emitPaymentUpdate: noop, emitPaymentCompleted: noop } as never,
  { paymentsCreated: { inc: noop }, paymentsTransitioned: { inc: noop }, walletCreditSkipped: { inc: noop } } as never,
  {} as never,
  {} as never,
  {} as never,
);
const pax = new PosDeviceService(prisma, paxPayments, audit as never, cls as never, new PaytefDeviceSaleProver());
const paxReception = new PosDeviceReceptionService(prisma, paxPayments, new CashTopUpService(prisma, audit as never), audit as never, cls as never);

const r = randomUUID().slice(0, 6);
const refBase = 1000 + Math.floor(Math.random() * 8000) * 10;
let refSeq = 0;
let A: string, B: string, chica: string, camarero: string, encargado: string, otroLocal: string, term: string;
let managerSecret = '';

const sys = <T>(fn: Parameters<PrismaService['asSystem']>[0]) => prisma.asSystem(fn) as Promise<T>;
const inCtx = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { traceId: `t-cancel-${tenantId.slice(0, 4)}`, tenantId });
    return fn();
  });

async function cobro(o: { status: string; amount: number; order?: string; tip?: number; by?: string }): Promise<{ id: string; ref: number }> {
  const ref = refBase + ++refSeq;
  const id = await sys<string>(async (tx) => {
    const p = await tx.payment.create({
      data: {
        tenantId: A,
        terminalId: term,
        createdByUserId: o.by ?? chica,
        idempotencyKey: `k-${randomUUID()}`,
        amountCents: o.amount,
        availableAmountCents: o.amount,
        qrToken: `qr-${randomUUID()}`,
        qrExpiresAt: new Date(Date.now() + 3600_000),
        status: o.status as never,
        provider: o.order ? 'REDSYS' : null,
        providerTxId: o.order ?? null,
        revenueCategory: 'CHICA_SERVICE',
        ref,
      },
    });
    if (o.order) {
      await tx.paymentAttempt.create({
        data: { paymentId: p.id, tenantId: A, provider: 'REDSYS', providerTxId: o.order, amountCents: o.amount + (o.tip ?? 0), tipCents: o.tip ?? 0, status: 'PENDING' },
      });
    }
    return p.id;
  });
  return { id, ref };
}

/** El aviso del banco (Redsys, firmado con la clave del comercio): «aprobado». */
async function bankApproves(order: string, amountCents: number, paymentId: string): Promise<void> {
  const fields = { Ds_Order: order, Ds_MerchantCode: MERCHANT, Ds_Response: '0000', Ds_TransactionType: '0', Ds_Amount: String(amountCents), Ds_Currency: '978' };
  const s = serializeAndSignJSONRequest(SECRET, { Ds_Merchant_Order: order, ...fields } as never);
  const body = `Ds_SignatureVersion=${s.Ds_SignatureVersion}&Ds_MerchantParameters=${encodeURIComponent(s.Ds_MerchantParameters)}&Ds_Signature=${encodeURIComponent(s.Ds_Signature)}&_paymentId=${paymentId}`;
  const d = await prisma.webhookDelivery.create({
    data: { provider: 'REDSYS', tenantId: A, externalEventId: `ev-${randomUUID()}`, rawBody: Buffer.from(body), signature: 'x' },
  });
  await processor.process({ data: { deliveryId: d.id.toString() } } as Job<{ deliveryId: string }>);
}

const statusOf = async (id: string) => (await sys<{ status: string } | null>((tx) => tx.payment.findUnique({ where: { id } })))?.status;
const lateEvents = (id: string) =>
  sys<Array<{ id: bigint; payload: unknown }>>((tx) => tx.paymentEvent.findMany({ where: { paymentId: id, eventType: 'payment.approval_unbooked' } }));
const cancelAs = (userId: string, role: string, id: string, tenantId = A) => inCtx(tenantId, () => payments.cancel(id, { userId, role, tenantId }));

beforeAll(async () => {
  await prisma.onModuleInit();
  managerSecret = totp.newSecret();
  await sys(async (tx) => {
    A = (await tx.venue.create({ data: { name: 'Sala Cancelar', slug: `cancelar-${r}` } })).id;
    B = (await tx.venue.create({ data: { name: 'Otro local', slug: `cancelar-b-${r}` } })).id;
    const user = async (tenantId: string, role: string, name: string, extra: Record<string, unknown> = {}) =>
      (await tx.user.create({ data: { tenantId, email: `${name}-${r}@x.es`, passwordHash: 'x', role: role as never, displayName: name, ...extra } })).id;
    chica = await user(A, 'OPERATOR', 'Lucia', { commissionBps: 5000 });
    camarero = await user(A, 'WAITER', 'Javi');
    encargado = await user(A, 'MANAGER', 'Marta', { totpSecret: totp.sealSecret(managerSecret) });
    otroLocal = await user(B, 'WAITER', 'Pepe');
    term = (await tx.terminal.create({ data: { tenantId: A, externalId: `TC-${r}`, label: 'Barra' } })).id;
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('cualquiera del personal cancela cualquier cobro sin pagar de su local', () => {
  it('el camarero cancela el cobro de la chica (antes 403) y queda quién lo canceló y que no fue quien lo creó', async () => {
    const { id } = await cobro({ status: 'AWAITING_CAPTURE', amount: 1500 });
    // En «Cobros → Sin pagar en el local» lo ve el camarero, de otra persona.
    const unpaid = await inCtx(A, () => listUnpaidCobros(prisma, { tenantId: A, userId: camarero }));
    expect(unpaid.find((u) => u.id === id)).toMatchObject({ mine: false, createdByName: 'Lucia', totalCents: 1500, atBank: false });
    await expect(cancelAs(camarero, 'WAITER', id)).resolves.toEqual({ status: 'CANCELED' });
    expect(await statusOf(id)).toBe('CANCELED');
    const ev = await sys<{ payload: unknown } | null>((tx) => tx.paymentEvent.findFirst({ where: { paymentId: id, eventType: 'payment.canceled' } }));
    expect(ev?.payload).toMatchObject({ reason: 'user-canceled', byUserId: camarero });
    // Ya no sale en «Sin pagar».
    expect((await inCtx(A, () => listUnpaidCobros(prisma, { tenantId: A, userId: camarero }))).some((u) => u.id === id)).toBe(false);
  });

  it('la chica cancela el del camarero; el de otro local no lo encuentra (404)', async () => {
    const { id } = await cobro({ status: 'CREATED', amount: 900, by: camarero });
    await expect(cancelAs(otroLocal, 'WAITER', id, B)).rejects.toMatchObject({ status: 404 });
    expect(await statusOf(id)).toBe('CREATED');
    await expect(cancelAs(chica, 'OPERATOR', id)).resolves.toEqual({ status: 'CANCELED' });
  });

  it('Redsys con el cliente en su banco (AUTHORIZING): se cancela; pagado, 409', async () => {
    const order = `AB${r}`;
    const { id } = await cobro({ status: 'AUTHORIZING', amount: 2000, order });
    const unpaid = await inCtx(A, () => listUnpaidCobros(prisma, { tenantId: A, userId: camarero }));
    expect(unpaid.find((u) => u.id === id)).toMatchObject({ atBank: true, bitcoin: false });
    await expect(cancelAs(camarero, 'WAITER', id)).resolves.toEqual({ status: 'CANCELED' });
    expect(await statusOf(id)).toBe('CANCELED');
    const paid = await cobro({ status: 'AUTHORIZED', amount: 700 });
    await expect(cancelAs(camarero, 'WAITER', paid.id)).rejects.toMatchObject({ status: 409 });
  });
});

describe('el banco cobra después de cancelar', () => {
  let late: { id: string; ref: number };
  const order = `LT${r}`;

  it('aviso firmado tardío → sigue CANCELADO, sin devolver, una incidencia y un Telegram aunque el aviso se repita', async () => {
    late = await cobro({ status: 'AUTHORIZING', amount: 1000, tip: 200, order });
    await cancelAs(camarero, 'WAITER', late.id);
    telegram.send.mockClear();
    await bankApproves(order, 1200, late.id);
    await bankApproves(order, 1200, late.id); // el banco lo repite
    await Promise.all([bankApproves(order, 1200, late.id), bankApproves(order, 1200, late.id)]); // y a la vez

    expect(await statusOf(late.id)).toBe('CANCELED');
    expect(refund).not.toHaveBeenCalled();
    const events = await lateEvents(late.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ reason: 'paid_after_cancel', providerTxId: order, amountCents: 1200, fromStatus: 'CANCELED' });
    const earnings = await sys<unknown[]>((tx) => tx.operatorEarning.findMany({ where: { paymentId: late.id } }));
    expect(earnings).toHaveLength(0);

    // Panel del encargado y del dueño.
    const title = `Pagó después de cancelar: C-${String(late.ref).padStart(4, '0')}, 12,00 €`;
    const inbox = await incidents.list(A);
    expect(inbox.filter((i) => i.paymentId === late.id)).toEqual([
      expect.objectContaining({ kind: 'approval_unbooked', title, noteRequired: true, acceptable: true }),
    ]);

    // Telegram: una vez, con el formato de los avisos de dinero y sin datos del cliente.
    await alerts.tick();
    await alerts.tick();
    const mine = telegram.send.mock.calls.map((c) => c[0]).filter((t) => t.includes('Sala Cancelar'));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.split('\n')[0]).toBe(`⚠️ Sala Cancelar: ${title}`);
  });

  it('recepción la ve (el camarero sin cerrarla); el cliente ve que se canceló pero su banco lo pagó', async () => {
    const forWaiter = await incidents.receptionInbox(A, 'WAITER');
    expect(forWaiter.find((i) => i.paymentId === late.id)).toMatchObject({ ackable: false, noteRequired: true });
    const forManager = await incidents.receptionInbox(A, 'MANAGER');
    expect(forManager.find((i) => i.paymentId === late.id)).toMatchObject({ ackable: true });

    const view = await payments.getResultView(order);
    expect(view).toMatchObject({ status: 'CANCELED', paidAfterCancel: true });
    const html = renderResultView(view, 'es', `/pay/result?op=${order}&lang=es`).replace(/\s+/g, ' ');
    expect(html).toContain('El cobro se canceló, pero tu banco lo ha pagado');
    expect(html).toContain('Habla con el personal: lo devolvemos o lo damos por bueno.');
    expect(html).not.toContain('No se te ha cobrado nada');
  });

  it('antes de procesar el aviso, la vuelta firmada del banco ya basta para no decir «cancelado» a secas', async () => {
    const o = `RV${r}`;
    const { id } = await cobro({ status: 'AUTHORIZING', amount: 800, order: o });
    await cancelAs(chica, 'OPERATOR', id);
    expect((await payments.getResultView(o))?.paidAfterCancel).toBeUndefined();
    expect(await payments.getResultView(o, { bankApproved: true })).toMatchObject({ status: 'CANCELED', paidAfterCancel: true });
  });

  it('«Dar por bueno»: encargado con 2FA → pagado con su propina y la comisión de la chica, incidencia cerrada con nota; dos veces, 409', async () => {
    const [ev] = await lateEvents(late.id);
    const eventId = ev!.id.toString();
    const manager = { sub: encargado, role: 'MANAGER', tenantId: A } as never;
    const body = { eventId, note: 'Se queda: era su segunda copa' };
    // Sin el código, no.
    await expect(inCtx(A, () => accept.accept(late.id, A, manager, body))).rejects.toBeTruthy();
    expect(await statusOf(late.id)).toBe('CANCELED');

    await expect(
      inCtx(A, () => accept.accept(late.id, A, manager, { ...body, totpCode: totpCodeAt(managerSecret) })),
    ).resolves.toEqual({ ok: true, newStatus: 'AUTHORIZED' });
    const p = await sys<{ status: string; tipCents: number; authorizedAt: Date | null } | null>((tx) => tx.payment.findUnique({ where: { id: late.id } }));
    expect(p).toMatchObject({ status: 'AUTHORIZED', tipCents: 200 });
    expect(p?.authorizedAt).not.toBeNull();
    const earning = await sys<{ commissionCents: number; tipCents: number } | null>((tx) => tx.operatorEarning.findFirst({ where: { paymentId: late.id } }));
    expect(earning).toMatchObject({ commissionCents: 500, tipCents: 200 });
    const ack = await sys<{ note: string | null } | null>((tx) => tx.incidentAck.findFirst({ where: { tenantId: A, kind: 'approval_unbooked', refId: eventId } }));
    expect(ack?.note).toBe('Dado por bueno: Se queda: era su segunda copa');
    expect(auditLog.some((e) => e.action === 'payment.accepted_after_cancel')).toBe(true);
    expect((await incidents.list(A)).some((i) => i.kind === 'approval_unbooked' && i.paymentId === late.id)).toBe(false);
    // Y el cliente ya ve «Pagado».
    expect((await payments.getResultView(order))?.status).toBe('AUTHORIZED');

    await expect(
      inCtx(A, () => accept.accept(late.id, A, manager, { ...body, totpCode: totpCodeAt(managerSecret) })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('cerrarla con nota sin darla por buena (devuelto en el banco): el cobro sigue cancelado', async () => {
    const o = `DV${r}`;
    const { id } = await cobro({ status: 'AUTHORIZING', amount: 1500, order: o });
    await cancelAs(camarero, 'WAITER', id);
    await bankApproves(o, 1500, id);
    const [ev] = await lateEvents(id);
    await inCtx(A, () => incidents.ackPaidAfterCancel(A, encargado, { refId: ev!.id.toString(), note: 'Devuelto en el portal del banco' }));
    expect(await statusOf(id)).toBe('CANCELED');
    expect((await incidents.receptionInbox(A, 'MANAGER')).some((i) => i.paymentId === id)).toBe(false);
  });
});

describe('la recarga cobrada en el datáfono sin comprobar: nadie del personal la cancela', () => {
  // Su propio local (con el datáfono encendido): sus incidencias no se mezclan con las de arriba.
  let C: string, recepcion: string;
  const staffC: Array<[string, string]> = [];
  const heldOnReader = {
    status: 409,
    response: { code: 'CANCEL_HELD_ON_READER', message: 'Cobrado en el datáfono: lo comprueba el dueño en Hoy → Cobros → Resolver' },
  };
  const walletOf = (id: string) => sys<{ balanceCents: number; status: string } | null>((tx) => tx.clientWallet.findUnique({ where: { id } }));

  beforeAll(async () => {
    await sys(async (tx) => {
      C = (await tx.venue.create({ data: { name: 'Sala Datáfono', slug: `cancelar-pax-${r}`, walletGroup: `gpax-${r}`, paymentMethods: { pos: true } } })).id;
      recepcion = (await tx.terminal.create({ data: { tenantId: C, externalId: `RC-${r}`, label: 'Recepción', reception: true } })).id;
      for (const [role, name] of [
        ['WAITER', 'Raul'],
        ['OPERATOR', 'Nerea'],
        ['MANAGER', 'Ines'],
        ['OWNER', 'Dueno'],
      ] as const) {
        const u = await tx.user.create({ data: { tenantId: C, email: `${name}-pax-${r}@x.es`, passwordHash: 'x', role: role as never, displayName: name } });
        staffC.push([u.id, role]);
      }
    });
  });

  it('la tarjeta ya pagó y el saldo espera: «Sin pagar» la enseña sin poder cancelarla, el API dice 409 y sigue en Incidencias', async () => {
    const device = { terminalId: recepcion, tenantId: C, label: 'Recepción', zone: null, tokenHash: 'x' };
    // Recarga de 50 € con tarjeta en el datáfono de recepción, con un saldo nuevo.
    const sale = await inCtx(C, () => paxReception.cardTopUp(device, { amountCents: 5_000, idempotencyKey: `pax-${r}`, wallet: { create: true } }));
    const op = `P${r}1`;
    const result = {
      approved: true,
      authorisationCode: '047215',
      paytefOperationNumber: op,
      transactionReference: posReference(sale.paymentId),
      requestedAmount: sale.amountCents,
      cardInformation: { hiddenCardNumber: '************4242', cardTypeCode: 'VI', isContactless: true },
    };
    await expect(inCtx(C, () => pax.reportResult(device, sale.paymentId, result))).resolves.toMatchObject({ status: 'PENDING', operationNumber: op });
    const held = await sys<{ status: string; provider: string | null; posOperationNumber: string | null; posTerminalId: string | null } | null>(
      (tx) => tx.payment.findUnique({ where: { id: sale.paymentId } }),
    );
    expect(held).toMatchObject({ status: 'AUTHORIZING', provider: 'PAYTEF', posOperationNumber: op, posTerminalId: recepcion });

    // «Sin pagar en el local»: sale, pero ni «en su banco» ni con «Cancelar».
    const [camareroC] = staffC[0]!;
    const row = (await inCtx(C, () => listUnpaidCobros(prisma, { tenantId: C, userId: camareroC }))).find((u) => u.id === sale.paymentId);
    expect(row).toMatchObject({ status: 'AUTHORIZING', heldOnReader: true, atBank: false, bitcoin: false, totalCents: sale.amountCents });

    // Nadie: ni el camarero, ni la chica, ni el encargado, ni el dueño.
    for (const [userId, role] of staffC) {
      await expect(cancelAs(userId, role, sale.paymentId, C)).rejects.toMatchObject(heldOnReader);
    }
    expect(await statusOf(sale.paymentId)).toBe('AUTHORIZING');
    expect(await sys<unknown[]>((tx) => tx.paymentEvent.findMany({ where: { paymentId: sale.paymentId, eventType: 'payment.canceled' } }))).toHaveLength(0);
    // Su saldo nuevo no se cierra (sigue esperando la recarga).
    expect(await walletOf(sale.walletId)).toMatchObject({ balanceCents: 0, status: 'ACTIVE' });
    // Y la incidencia sigue ahí, para resolverla.
    expect((await incidents.list(C)).find((i) => i.kind === 'approval_unverified' && i.paymentId === sale.paymentId)).toMatchObject({
      title: 'Recarga del datáfono sin comprobar',
      amountCents: sale.amountCents,
    });

    // Se resuelve en el panel (Resolver: dada por cobrada): se suma al saldo y la incidencia se va.
    await inCtx(C, () => payments.transition(sale.paymentId, { type: 'AUTHORIZED', provider: 'PAYTEF', providerTxId: op }, C));
    expect(await walletOf(sale.walletId)).toMatchObject({ balanceCents: 5_000, status: 'ACTIVE' });
    expect((await incidents.list(C)).some((i) => i.kind === 'approval_unverified' && i.paymentId === sale.paymentId)).toBe(false);
    expect((await inCtx(C, () => listUnpaidCobros(prisma, { tenantId: C, userId: camareroC }))).some((u) => u.id === sale.paymentId)).toBe(false);
  });
});
