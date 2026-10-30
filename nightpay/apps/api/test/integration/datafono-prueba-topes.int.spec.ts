// Integración (Postgres real, np_app sin superusuario y FORCE RLS): la recarga
// con tarjeta del datáfono no se suma con la palabra del datáfono (seguridad #1),
// topes de la recepción (seguridad #3), efectivo solo en el de recepción
// (dinero #5), clave repetida (pagos #8), cierre (pagos #9) y saldos vacíos
// de ventas que no se cobraron (pagos #10). Ver README.md.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { Prisma } from '@nightpay/db';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { IncidentsService } from '../../src/modules/incidents/incidents.service';
import { unresolvedPaymentsWhere } from '../../src/modules/nights/night-rules';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { posReference } from '../../src/modules/pos-device/paytef';
import { PosDeviceReceptionService } from '../../src/modules/pos-device/pos-device-reception.service';
import { PosDeviceService } from '../../src/modules/pos-device/pos-device.service';
import { PaytefDeviceSaleProver, type PosSaleProver } from '../../src/modules/pos-device/pos-sale-proof';
import { CashTopUpService } from '../../src/modules/wallets/wallet-cash-topup.service';
import { WalletChargesService } from '../../src/modules/wallets/wallet-charges.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = new AuditService(prisma, cls as never);
const incidents = new IncidentsService(prisma, audit);
const cash = new CashTopUpService(prisma, audit);
const charges = new WalletChargesService(prisma, audit, { get: () => null } as never, {} as never);
const queue = { add: vi.fn(async () => undefined) };
const payments = new PaymentsService(
  prisma as never,
  cls as never,
  queue as never,
  queue as never,
  {} as never,
  { emitPaymentUpdate: vi.fn(), emitPaymentCompleted: vi.fn() } as never,
  { paymentsCreated: { inc: vi.fn() }, paymentsTransitioned: { inc: vi.fn() }, walletCreditSkipped: { inc: vi.fn() } } as never,
  {} as never,
  {} as never,
  {} as never,
);
// Lo de producción: Paytef no deja comprobar una venta del PAX desde el servidor.
const pos = new PosDeviceService(prisma, payments, audit, cls as never, new PaytefDeviceSaleProver());
// Como sería con una consulta de Paytef que confirma la venta.
const paytefConfirms: PosSaleProver = {
  prove: (claim) => Promise.resolve({ kind: 'confirmed', amountCents: claim.amountCents, currency: 'EUR' }),
};
const posWithProof = new PosDeviceService(prisma, payments, audit, cls as never, paytefConfirms);
const reception = new PosDeviceReceptionService(prisma, payments, cash, audit, cls as never);

function inVenue<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: `t-${tenantId.slice(0, 4)}`, tenantId });
    return fn();
  });
}
function seed<T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't-seed' });
    return prisma.asSystem(fn);
  });
}

const r = randomUUID().slice(0, 6);
let k = 0;
const key = () => `prueba-${r}-${(k += 1)}`;
let op = 0;
const nextOp = () => `P${r}${(op += 1)}`;

let venue: string;
let rec: string;
let barra: string;
const device = (terminalId = rec) => ({ terminalId, tenantId: venue, label: terminalId === rec ? 'Recepción' : 'Barra', zone: null, tokenHash: 'x' });
const approved = (paymentId: string, amountCents: number, operation: string) => ({
  approved: true,
  authorisationCode: '047215',
  paytefOperationNumber: operation,
  transactionReference: posReference(paymentId),
  requestedAmount: amountCents,
  cardInformation: { hiddenCardNumber: '************4242', cardTypeCode: 'VI', isContactless: true },
});
const walletOf = async (id: string) =>
  (await seed((tx) => tx.clientWallet.findUnique({ where: { id }, select: { balanceCents: true, status: true, shortCode: true } })))!;
const paymentOf = async (id: string) => (await seed((tx) => tx.payment.findUnique({ where: { id } })))!;

beforeAll(async () => {
  await prisma.onModuleInit();
  await seed(async (tx) => {
    venue = (
      await tx.venue.create({
        data: {
          name: 'Local Prueba',
          slug: `dpt-${r}`,
          walletGroup: `gdpt-${r}`,
          staffPermissions: { roles: { DEVICE: { cashTopUp: true } } },
          // Cobra con datáfono: lo guardó encendido (de fábrica va apagado desde el 20-10-2026).
          paymentMethods: { pos: true },
        },
      })
    ).id;
    rec = (await tx.terminal.create({ data: { tenantId: venue, externalId: `REC-${r}`, label: 'Recepción', reception: true } })).id;
    barra = (await tx.terminal.create({ data: { tenantId: venue, externalId: `BAR-${r}`, label: 'Barra' } })).id;
  });
});

afterEach(() => {
  delete process.env.POS_RECEPTION_TERMINAL_DAILY_CAP_EUR;
  delete process.env.POS_RECEPTION_WALLET_DAILY_CAP_EUR;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('recarga con tarjeta del datáfono: la palabra del datáfono no basta (seguridad #1)', () => {
  it('venta «aprobada» sin la prueba de Paytef: NO se suma, queda en Incidencias y la resuelve el dueño', async () => {
    const sale = await inVenue(venue, () =>
      reception.cardTopUp(device(), { amountCents: 1_000_000, idempotencyKey: key(), wallet: { create: true } }),
    );
    const operation = nextOp();
    // Lo que manda un datáfono (o quien tenga su credencial): aprobada, operación inventada.
    const out = await inVenue(venue, () => pos.reportResult(device(), sale.paymentId, approved(sale.paymentId, 1_000_000, operation)));
    expect(out).toMatchObject({ status: 'PENDING', operationNumber: operation });
    expect(await walletOf(sale.walletId)).toMatchObject({ balanceCents: 0 });
    expect(await paymentOf(sale.paymentId)).toMatchObject({
      status: 'AUTHORIZING',
      posOperationNumber: operation,
      posTerminalId: rec,
      provider: 'PAYTEF',
      providerTxId: operation,
      authorizedAt: null,
    });
    // Reenviarlo no suma nada.
    await expect(
      inVenue(venue, () => pos.reportResult(device(), sale.paymentId, approved(sale.paymentId, 1_000_000, operation))),
    ).resolves.toMatchObject({ status: 'PENDING' });
    expect(await walletOf(sale.walletId)).toMatchObject({ balanceCents: 0 });
    // Sin recarga cobrada, el datáfono no pone el PIN de ese saldo (ni enseña su código).
    await expect(inVenue(venue, () => charges.setPinFromTerminal({ terminalId: rec, tenantId: venue }, sale.walletId, '4827'))).rejects.toThrow(
      /Saldo no encontrado/,
    );
    await expect(inVenue(venue, () => reception.topUpResult(device(), sale.paymentId))).resolves.toMatchObject({
      status: 'PENDING',
      balanceCents: null,
    });
    // En la bandeja: «Recarga del datáfono sin comprobar».
    const open = await inVenue(venue, () => incidents.list(venue));
    expect(open.find((i) => i.kind === 'approval_unverified' && i.paymentId === sale.paymentId)).toMatchObject({
      title: 'Recarga del datáfono sin comprobar',
      amountCents: 1_000_000,
    });
    // El cierre de la noche la cuenta como cobro sin terminar.
    const pending = await seed((tx) =>
      tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM payments WHERE ${unresolvedPaymentsWhere(venue, { from: new Date(Date.now() - 3_600_000), to: new Date() })}`,
    );
    expect(pending.map((p) => p.id)).toContain(sale.paymentId);

    // El dueño lo ve en el panel de Paytef y la da por cobrada (Pagos → Resolver).
    await inVenue(venue, () => payments.transition(sale.paymentId, { type: 'AUTHORIZED', provider: 'PAYTEF', providerTxId: operation }, venue));
    expect(await walletOf(sale.walletId)).toMatchObject({ balanceCents: 1_000_000, status: 'ACTIVE' });
    await expect(inVenue(venue, () => reception.topUpResult(device(), sale.paymentId))).resolves.toMatchObject({
      status: 'CREDITED',
      balanceCents: 1_000_000,
    });
    const after = await inVenue(venue, () => incidents.list(venue));
    expect(after.some((i) => i.kind === 'approval_unverified' && i.paymentId === sale.paymentId)).toBe(false);
  });

  it('a la ficha de un saldo que ya tenía dinero: tampoco se suma sin la prueba', async () => {
    const top = await inVenue(venue, () =>
      cash.topUp(venue, { terminalId: rec }, { amountCents: 2_000, idempotencyKey: key(), wallet: { create: true } }),
    );
    // La recarga a un saldo que ya existe (por su id, como queda tras acercar la ficha).
    const toExisting = await inVenue(venue, () =>
      payments.create(venue, `reception:${rec}:${key()}`, { amountCents: 5_000, currency: 'EUR', wallet: { walletId: top.walletId } }, undefined, {
        viaDevice: { terminalId: rec },
      }),
    );
    await seed((tx) =>
      tx.paymentEvent.create({
        data: { paymentId: toExisting.id, tenantId: venue, eventType: 'pos.device_started', payload: { terminalId: rec }, traceId: 't' },
      }),
    );
    await expect(
      inVenue(venue, () => pos.reportResult(device(), toExisting.id, approved(toExisting.id, 5_000, nextOp()))),
    ).resolves.toMatchObject({ status: 'PENDING' });
    expect(await walletOf(top.walletId)).toMatchObject({ balanceCents: 2_000 });
  });

  it('con la prueba de Paytef, la venta se suma al momento (lo de antes)', async () => {
    const sale = await inVenue(venue, () =>
      reception.cardTopUp(device(), { amountCents: 6_000, idempotencyKey: key(), wallet: { create: true } }),
    );
    await expect(
      inVenue(venue, () => posWithProof.reportResult(device(), sale.paymentId, approved(sale.paymentId, 6_000, nextOp()))),
    ).resolves.toMatchObject({ status: 'PAID' });
    expect(await walletOf(sale.walletId)).toMatchObject({ balanceCents: 6_000 });
  });

  it('la misma clave tras cobrarse (o quedar pendiente) → 409: el lector no cobra otra vez (pagos #8)', async () => {
    const idem = key();
    const sale = await inVenue(venue, () => reception.cardTopUp(device(), { amountCents: 1_500, idempotencyKey: idem, wallet: { create: true } }));
    // Repetida mientras sigue abierta: la misma venta.
    await expect(
      inVenue(venue, () => reception.cardTopUp(device(), { amountCents: 1_500, idempotencyKey: idem, wallet: { create: true } })),
    ).resolves.toMatchObject({ paymentId: sale.paymentId });
    await inVenue(venue, () => pos.reportResult(device(), sale.paymentId, approved(sale.paymentId, 1_500, nextOp())));
    await expect(
      inVenue(venue, () => reception.cardTopUp(device(), { amountCents: 1_500, idempotencyKey: idem, wallet: { create: true } })),
    ).rejects.toThrow(/ya se cobró, caducó o se canceló/);
  });
});

describe('saldo vacío de una venta que no se cobró (pagos #10)', () => {
  it('denegada y caducada: el saldo nuevo se cierra (EXPIRED) y suelta su código', async () => {
    const sale = await inVenue(venue, () =>
      reception.cardTopUp(device(), { amountCents: 3_000, idempotencyKey: key(), wallet: { create: true } }),
    );
    await inVenue(venue, () => pos.reportResult(device(), sale.paymentId, { approved: false, resultText: 'DENEGADA' }));
    expect(await walletOf(sale.walletId)).toMatchObject({ status: 'ACTIVE' });
    // El trabajo de caducidad (qr-expire) hace esta transición.
    await inVenue(venue, () => payments.transition(sale.paymentId, { type: 'TIMEOUT' }, venue));
    expect(await walletOf(sale.walletId)).toMatchObject({ status: 'EXPIRED', balanceCents: 0 });
  });

  it('un saldo que ya existía (con dinero) no se toca aunque la recarga caduque', async () => {
    const top = await inVenue(venue, () =>
      cash.topUp(venue, { terminalId: rec }, { amountCents: 1_000, idempotencyKey: key(), wallet: { create: true } }),
    );
    const p = await inVenue(venue, () =>
      payments.create(venue, `reception:${rec}:${key()}`, { amountCents: 2_000, currency: 'EUR', wallet: { walletId: top.walletId } }, undefined, {
        viaDevice: { terminalId: rec },
      }),
    );
    await inVenue(venue, () => payments.transition(p.id, { type: 'TIMEOUT' }, venue));
    expect(await walletOf(top.walletId)).toMatchObject({ status: 'ACTIVE', balanceCents: 1_000 });
  });
});

describe('recepción del datáfono: efectivo solo en el de recepción y topes de 24 h (dinero #5, seguridad #3)', () => {
  it('la barra (sin marcar) no cobra efectivo ni lo ofrece', async () => {
    await expect(
      inVenue(venue, () => reception.cashTopUp(device(barra), { amountCents: 1_000, idempotencyKey: key(), wallet: { create: true } })),
    ).rejects.toThrow(/no es el de la recepción/);
    await expect(inVenue(venue, () => reception.options(device(barra)))).resolves.toMatchObject({ cash: false });
    await expect(inVenue(venue, () => reception.options(device()))).resolves.toMatchObject({ cash: true });
  });

  it('tope del saldo: tarjeta y efectivo suman; pasarlo no cobra y queda en Incidencias', async () => {
    process.env.POS_RECEPTION_WALLET_DAILY_CAP_EUR = '70';
    const first = await inVenue(venue, () =>
      reception.cashTopUp(device(), { amountCents: 6_000, idempotencyKey: key(), wallet: { create: true } }),
    );
    const err = await inVenue(venue, () =>
      reception.cashTopUp(device(), { amountCents: 2_000, idempotencyKey: key(), wallet: { code: first.code } }),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ response: { code: 'RECEPTION_LIMIT', limit: 'wallet_daily' } });
    expect(await walletOf(first.walletId)).toMatchObject({ balanceCents: 6_000 });
    // Hasta el tope, sí.
    await inVenue(venue, () => reception.cashTopUp(device(), { amountCents: 1_000, idempotencyKey: key(), wallet: { code: first.code } }));
    expect(await walletOf(first.walletId)).toMatchObject({ balanceCents: 7_000 });
    const open = await inVenue(venue, () => incidents.list(venue));
    expect(open.find((i) => i.kind === 'pos_reception_limit')?.detail).toContain('el tope de recargas de un saldo en 24 h');
  });

  it('tope del datáfono: lo cargado por él en 24 h (también con tarjeta) frena la siguiente', async () => {
    const used = await seed((tx) =>
      tx.$queryRaw<Array<{ cents: number }>>`
        SELECT (COALESCE((SELECT SUM("amountCents") FROM payments WHERE "terminalId" = ${rec}::uuid AND "captureMethod" = 'WALLET_TOPUP'
                           AND status::text NOT IN ('EXPIRED','CANCELED','FAILED')), 0)
              + COALESCE((SELECT SUM("amountCents") FROM wallet_cash_topups WHERE "terminalId" = ${rec}::uuid), 0))::int AS cents`,
    );
    // El tope, justo lo que ya lleva + 10 €.
    process.env.POS_RECEPTION_TERMINAL_DAILY_CAP_EUR = String(used[0]!.cents / 100 + 10);
    await inVenue(venue, () => reception.cashTopUp(device(), { amountCents: 1_000, idempotencyKey: key(), wallet: { create: true } }));
    const err = await inVenue(venue, () =>
      reception.cardTopUp(device(), { amountCents: 100, idempotencyKey: key(), wallet: { create: true } }),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ response: { code: 'RECEPTION_LIMIT', limit: 'terminal_daily' } });
    const limitAudits = await seed((tx) =>
      tx.auditEvent.count({ where: { tenantId: venue, action: 'pos.reception_limit_exceeded', targetId: rec } }),
    );
    expect(limitAudits).toBeGreaterThanOrEqual(2);
  });
});

describe('columnas nuevas de terminals (20261022100000)', () => {
  it('reception por defecto false; deviceTokenNextIssuedAt existe', async () => {
    const t = await seed((tx) => tx.terminal.findUnique({ where: { id: barra }, select: { reception: true, deviceTokenNextIssuedAt: true } }));
    expect(t).toEqual({ reception: false, deviceTokenNextIssuedAt: null });
    const cols = await seed((tx) =>
      tx.$queryRaw<Array<{ column_name: string }>>(
        Prisma.sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'terminals' AND column_name IN ('reception', 'deviceTokenNextIssuedAt') ORDER BY 1`,
      ),
    );
    expect(cols.map((c) => c.column_name)).toEqual(['deviceTokenNextIssuedAt', 'reception']);
  });
});
