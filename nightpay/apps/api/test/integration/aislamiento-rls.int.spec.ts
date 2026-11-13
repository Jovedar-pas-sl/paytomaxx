// Integración (Postgres real): RLS de la base aísla los locales por sí sola en las tablas con FORCE RLS,
// con el rol dueño SIN superusuario, aunque la consulta no filtre por local. Ver README.md y docs/DB-ROLE.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { PrismaService, RlsOutsideTransactionError } from '../../src/common/prisma/prisma.service';
import { FORCED_RLS_TABLES } from '../../src/common/prisma/rls';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);

function inCtx<T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { traceId: 't-rls', tenantId });
    return fn();
  });
}

const r = randomUUID().slice(0, 6);
type Table = (typeof FORCED_RLS_TABLES)[number];
type Rows = Record<Table, string>;
let A: string, B: string;
let rowsA: Rows, rowsB: Rows;

/** Una fila de cada tabla con FORCE RLS en el local. */
async function seed(tag: string): Promise<{ tenantId: string; rows: Rows }> {
  return inCtx(undefined, () =>
    prisma.asSystem(async (tx) => {
      const tenantId = (await tx.venue.create({ data: { name: `RLS ${tag}`, slug: `rls-${tag}-${r}` } })).id;
      const owner = (await tx.user.create({ data: { tenantId, email: `rls-o-${tag}-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
      const chica = (await tx.user.create({ data: { tenantId, email: `rls-c-${tag}-${r}@x.es`, passwordHash: 'x', role: 'OPERATOR' } })).id;
      const term = (await tx.terminal.create({ data: { tenantId, externalId: `RLS-${tag}-${r}`, label: tag } })).id;
      const payment = await tx.payment.create({
        data: {
          tenantId, terminalId: term, idempotencyKey: `rls-${tag}-${r}`, qrToken: `rls-${tag}-${r}`, qrExpiresAt: new Date(Date.now() + 3600_000),
          amountCents: 1000, availableAmountCents: 1000, status: 'AUTHORIZING', provider: 'PEANPE', createdByUserId: chica,
        },
      });
      const wallet = await tx.clientWallet.create({ data: { tenantId, balanceCents: 500, qrToken: `rls-w-${tag}-${r}` } });
      const consumption = await tx.walletConsumption.create({
        data: { tenantId, walletId: wallet.id, amountCents: 100, providedByUserId: chica, category: 'CHICA_SERVICE' },
      });
      const payout = await tx.operatorPayout.create({ data: { tenantId, operatorId: chica, totalCents: 50, paidByUserId: owner } });
      const earning = await tx.operatorEarning.create({
        data: { tenantId, operatorId: chica, consumptionId: consumption.id, paymentAmountCents: 100, commissionBps: 5000, commissionCents: 50, payoutId: payout.id },
      });
      const reversal = await tx.earningReversal.create({
        data: { tenantId, earningId: earning.id, consumptionId: consumption.id, reversedDeltaCents: 50, afterPayout: true },
      });
      const call = await tx.peanpeCall.create({
        data: { tenantId, paymentId: payment.id, identificadorLlamada: `${tag}${r}`.slice(0, 6), securityToken: '1234567890', amountCents: 1000 },
      });
      const approval = await tx.approvalRequest.create({
        data: { tenantId, kind: 'PAYOUT', targetId: chica, amountCents: 50, payload: {}, requestedById: owner },
      });
      const cashTopUp = await tx.walletCashTopUp.create({
        data: { tenantId, walletId: wallet.id, amountCents: 500, takenByUserId: owner, idempotencyKey: `rls-${tag}-${r}` },
      });
      // El mapa del dinero: la línea del cobro y el contador de su referencia.
      const line = await tx.paymentLine.create({
        data: { tenantId, paymentId: payment.id, category: 'CHICA_SERVICE', label: 'Servicio', unitCents: 1000, amountCents: 1000 },
      });
      await tx.chargeRefCounter.create({ data: { tenantId, lastRef: 1 } });
      // «Liquidación OxioPay»: lo que el local debe a OxioPay y un pago apuntado.
      const settlement = await tx.oxioPaySettlement.create({
        data: {
          tenantId, periodFrom: new Date('2026-10-26T07:00:00Z'), periodTo: new Date('2026-11-02T07:00:00Z'), isoYear: 2026, isoWeek: 44,
          reference: `OXP-2026-S44-RLS-${tag}-${r}`.toUpperCase(), periodCents: 100, totalCents: 100, moneyMapCents: 100,
          breakdown: { version: 1, party: { venueName: `RLS ${tag}`, venueSlug: `rls-${tag}-${r}`, businessName: null, businessTaxId: null }, platformBps: 1000, nights: [], adjustments: [] },
          status: 'PARTIALLY_PAID', paidCents: 50,
        },
      });
      const settlementPayment = await tx.oxioPaySettlementPayment.create({
        data: { tenantId, settlementId: settlement.id, amountCents: 50, paidOn: new Date('2026-11-03T00:00:00Z'), bankReference: 'TRF', reason: 'A cuenta', recordedById: owner },
      });
      // La carta: un producto con su logo (bytes de mentira; la base solo mira tipo, tamaño, medidas y huella).
      const item = await tx.serviceItem.create({ data: { tenantId, name: `RLS ${tag}`, priceCents: 500, category: 'VENUE_BAR' } });
      await tx.serviceItemImage.create({
        data: { serviceItemId: item.id, tenantId, contentType: 'image/png', data: Buffer.alloc(64, 1), contentHash: 'a'.repeat(64), width: 64, height: 64 },
      });
      // «Pagar con bitcoin»: la conexión a su BTCPay (con la clave cifrada) y una factura del cobro.
      const btcStore = await tx.btcpayStore.create({
        data: { tenantId, baseUrl: 'https://pay.ejemplo.es', storeId: `st${tag}${r}`, apiKeyEnc: 'x:y:z', hookToken: `hk-${tag}-${r}` },
      });
      const btcInvoice = await tx.btcpayInvoice.create({
        data: {
          tenantId, paymentId: payment.id, invoiceId: `inv-${tag}-${r}`, storeId: btcStore.storeId, amountCents: 1000,
          checkoutLink: 'https://pay.ejemplo.es/i/x', qrLink: 'bitcoin:bc1qx?amount=0.001', expiresAt: new Date(Date.now() + 900_000),
        },
      });
      // La foto de perfil de la compañera (bytes de mentira; la base solo mira tipo, tamaño, medidas y huella).
      await tx.userPhoto.create({
        data: { userId: chica, tenantId, contentType: 'image/jpeg', data: Buffer.alloc(64, 2), contentHash: 'b'.repeat(64), width: 128, height: 128 },
      });
      // OxioParty: una caseta con su IBAN.
      const stall = await tx.stall.create({
        data: { tenantId, name: `Caseta ${tag}`, managerName: 'Responsable', organizerBps: 2500, iban: 'ES9121000418450200051332' },
      });
      // OxioParty: «Lo que sobra», una devolución pedida por transferencia (con su IBAN y su titular).
      const refund = await tx.partyRefundRequest.create({
        data: { tenantId, walletId: wallet.id, amountCents: 300, method: 'TRANSFER', iban: 'ES9121000418450200051332', holderName: 'Ana Pérez' },
      });
      return {
        tenantId,
        rows: {
          client_wallets: wallet.id,
          wallet_consumptions: consumption.id,
          operator_earnings: earning.id,
          operator_payouts: payout.id,
          earning_reversals: reversal.id,
          peanpe_calls: call.identificadorLlamada,
          approval_requests: approval.id,
          wallet_cash_topups: cashTopUp.id,
          payment_lines: line.id,
          charge_ref_counters: tenantId,
          oxiopay_settlements: settlement.id,
          oxiopay_settlement_payments: settlementPayment.id,
          service_item_images: item.id,
          btcpay_stores: btcStore.id,
          btcpay_invoices: btcInvoice.id,
          user_photos: chica,
          stalls: stall.id,
          party_refund_requests: refund.id,
        },
      };
    }),
  );
}

/** Locales de las filas de A y B que se ven, SIN filtrar por local en la consulta. */
async function visibleTenants(tx: { $queryRawUnsafe: PrismaService['$queryRawUnsafe'] }, table: Table): Promise<string[]> {
  // peanpe_calls tiene de clave el identificador de la llamada, service_item_images
  // el producto y charge_ref_counters el local; las demás, id.
  const key =
    table === 'peanpe_calls'
      ? 'identificador_llamada'
      : table === 'charge_ref_counters'
        ? '"tenantId"::text'
        : table === 'service_item_images'
          ? '"serviceItemId"::text'
          : table === 'user_photos'
            ? '"userId"::text'
            : 'id::text';
  const rows = await tx.$queryRawUnsafe<Array<{ t: string }>>(
    `SELECT "tenantId"::text AS t FROM ${table} WHERE ${key} = ANY($1::text[]) ORDER BY 1`,
    [rowsA[table], rowsB[table]],
  );
  return rows.map((x) => x.t);
}

beforeAll(async () => {
  await prisma.onModuleInit();
  ({ tenantId: A, rows: rowsA } = await seed('A'));
  ({ tenantId: B, rows: rowsB } = await seed('B'));
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('RLS de la base con un rol sin superusuario', () => {
  it('la prueba vale: el rol no es superusuario, no salta RLS, es dueño de las tablas y todas tienen FORCE', async () => {
    const [role] = await prisma.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const tables = await prisma.$queryRaw<Array<{ relname: string; owner: string; me: string; forced: boolean }>>`
      SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, current_user::text AS me, c.relforcerowsecurity AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY(${[...FORCED_RLS_TABLES]}::text[])
       ORDER BY 1`;
    expect(tables).toHaveLength(FORCED_RLS_TABLES.length);
    for (const t of tables) expect(t).toMatchObject({ owner: t.me, forced: true });
  });

  it('con el local A en la sesión, ninguna enseña filas de B aunque la consulta no filtre', async () => {
    for (const table of FORCED_RLS_TABLES) {
      expect(await inCtx(A, () => prisma.withTenant(A, (tx) => visibleTenants(tx, table))), table).toEqual([A]);
      expect(await inCtx(undefined, () => prisma.withTenant(B, (tx) => visibleTenants(tx, table))), table).toEqual([B]);
    }
  });

  it('también por modelo sin filtro del middleware (saldos y Peanpe no van por él): solo RLS', async () => {
    const wallets = await prisma.withTenant(A, (tx) =>
      tx.clientWallet.findMany({ where: { id: { in: [rowsA.client_wallets, rowsB.client_wallets] } }, select: { tenantId: true } }),
    );
    expect(wallets).toEqual([{ tenantId: A }]);
    const calls = await prisma.withTenant(A, (tx) =>
      tx.peanpeCall.findMany({
        where: { identificadorLlamada: { in: [rowsA.peanpe_calls, rowsB.peanpe_calls] } },
        select: { tenantId: true },
      }),
    );
    expect(calls).toEqual([{ tenantId: A }]);
  });

  it('una petición del personal con $transaction lleva su local en la sesión', async () => {
    for (const table of FORCED_RLS_TABLES) {
      expect(await inCtx(A, () => prisma.$transaction((tx) => visibleTenants(tx, table))), table).toEqual([A]);
    }
  });

  it('no se puede escribir en otro local: el INSERT lo para la base y el UPDATE no ve la fila', async () => {
    const chicaB = await prisma.asSystem((tx) => tx.operatorPayout.findUniqueOrThrow({ where: { id: rowsB.operator_payouts } }));
    await expect(
      prisma.withTenant(A, (tx) => tx.$executeRaw`
        INSERT INTO operator_payouts ("tenantId", "operatorId", "totalCents", "paidByUserId")
        VALUES (${B}::uuid, ${chicaB.operatorId}::uuid, 100, ${chicaB.paidByUserId}::uuid)`),
    ).rejects.toThrow(/row-level security/);
    const updated = await prisma.withTenant(A, (tx) =>
      tx.$executeRaw`UPDATE client_wallets SET "balanceCents" = 0 WHERE id = ${rowsB.client_wallets}::uuid`,
    );
    expect(updated).toBe(0);
    const still = await prisma.asSystem((tx) => tx.clientWallet.findUniqueOrThrow({ where: { id: rowsB.client_wallets } }));
    expect(still.balanceCents).toBe(500);
  });

  it('sin local ni bypass (lo que veía antes createPayout) no se ve nada; asSystem y acrossVenues ven los dos', async () => {
    for (const table of FORCED_RLS_TABLES) {
      expect(await inCtx(undefined, () => prisma.$transaction((tx) => visibleTenants(tx, table))), table).toEqual([]);
      expect(await inCtx(A, () => prisma.asSystem((tx) => visibleTenants(tx, table))), table).toEqual([A, B].sort());
      expect(await inCtx(A, () => prisma.acrossVenues((tx) => visibleTenants(tx, table))), table).toEqual([A, B].sort());
    }
  });

  it('fuera de una transacción: con TENANCY_UNSCOPED_QUERIES=throw se corta; en modo log no ve filas (y se avisa)', async () => {
    const before = process.env.TENANCY_UNSCOPED_QUERIES;
    try {
      process.env.TENANCY_UNSCOPED_QUERIES = 'throw';
      await expect(inCtx(A, () => prisma.operatorEarning.findMany({ where: { id: rowsA.operator_earnings } }))).rejects.toThrow(
        RlsOutsideTransactionError,
      );
      await expect(
        inCtx(A, () => prisma.$queryRaw`SELECT id FROM client_wallets WHERE id = ${rowsA.client_wallets}::uuid`),
      ).rejects.toThrow(RlsOutsideTransactionError);
      process.env.TENANCY_UNSCOPED_QUERIES = 'log';
      expect(await inCtx(A, () => prisma.operatorEarning.findMany({ where: { id: rowsA.operator_earnings } }))).toEqual([]);
    } finally {
      process.env.TENANCY_UNSCOPED_QUERIES = before;
    }
  });

  it('el local de una transacción no se queda en la conexión (vuelve al pool limpia)', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => prisma.withTenant(i % 2 ? A : B, (tx) => tx.$queryRaw`SELECT 1`)));
    const after = await Promise.all(
      Array.from({ length: 12 }, () =>
        prisma.$transaction((tx) => tx.$queryRaw<Array<{ t: string | null }>>`SELECT current_setting('app.current_tenant_id', true) AS t`),
      ),
    );
    for (const [row] of after) expect(row?.t ?? '').toBe('');
  });
});
