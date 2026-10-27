// Integración (Postgres real, np_app sin superusuario, FORCE RLS): la
// «Liquidación OxioPay». Locales con la comisión del servicio encendida,
// apagada y con saldo cargado antes de encenderla; una semana normal y la del
// cambio de hora de octubre; la noche que cruza el corte del lunes; una
// devolución dentro de la semana y otra apuntada tarde con fecha de una
// semana ya liquidada (ajuste en la siguiente); el repaso de dos réplicas a
// la vez; pagada entera, en parte, anulada y regenerada (con 2FA de verdad y
// el registro); lo que ve cada local; el aviso de 7 días; la cuenta de
// OxioPay; y que el total de cada semana CUADRA con el mapa del dinero de esa
// ventana. Los cobros, recargas, consumos y devoluciones se escriben con su
// fecha (como los deja el API: el aviso del banco que llega tarde, la
// devolución de BBVA apuntada días después) para situarlos en semanas
// concretas sin depender del reloj. Ver README.md.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ClsService } from 'nestjs-cls';
import { ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import * as speakeasy from 'speakeasy';
import { conceptsTotal, type SettlementConceptAmounts } from '@nightpay/contracts';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { RELEASE_LOCK_LUA } from '../../src/common/redis/release-lock';
import { AuditService } from '../../src/modules/audit/audit.service';
import { LockoutService } from '../../src/modules/auth/lockout.service';
import { CLAIM_STEP_LUA, TotpAttemptsService } from '../../src/modules/auth/totp-attempts.service';
import { totpStepAt } from '../../src/modules/auth/totp-code';
import { sealTotpSecret } from '../../src/modules/auth/totp-crypto';
import { TotpService } from '../../src/modules/auth/totp.service';
import { claimStepScript, createFakeRedis } from '../../src/modules/auth/testing/fake-redis';
import { MoneyMapService } from '../../src/modules/money-map/money-map.service';
import { oxioPayCentsOf } from '../../src/modules/money-map/money-map-rules';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { OxioPaySettlementsCron } from '../../src/modules/oxiopay-settlements/oxiopay-settlements.cron';
import { OxioPaySettlementsService } from '../../src/modules/oxiopay-settlements/oxiopay-settlements.service';
import { settlementCsv, settlementDocumentHtml } from '../../src/modules/oxiopay-settlements/settlement-document';
import { nightsOf, weekStartingOn, type SettlementWeek } from '../../src/modules/oxiopay-settlements/settlement-week';
import { SuperAdminSettlementsService } from '../../src/modules/superadmin/settlements.service';
import { SuperAdminStepUpService } from '../../src/modules/superadmin/step-up.service';
import { SuperAdminAuditService } from '../../src/modules/superadmin/superadmin-audit.service';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const audit = new AuditService(prisma as never, cls as never);
const reports = new ReportsService(prisma);
const moneyMap = new MoneyMapService(prisma, reports, { get: () => undefined } as never);
const settlements = new OxioPaySettlementsService(prisma, moneyMap, audit);
const saAudit = new SuperAdminAuditService(audit);
/** Un código por paso de 30 s no da para todas las pruebas: el 2FA de verdad, en su prueba. */
const okStepUp = { verify: async () => undefined } as unknown as SuperAdminStepUpService;
const sa = new SuperAdminSettlementsService(settlements, okStepUp, saAudit);

const inVenue = <T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> =>
  cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 'liq' });
    return fn();
  });
const sys = <T>(fn: (tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) => Promise<T>) => inVenue(undefined, () => prisma.asSystem(fn));

const r = randomUUID().slice(0, 6);
let seq = 0;
const T = (iso: string) => new Date(iso);
const c = (o: Partial<SettlementConceptAmounts>): SettlementConceptAmounts => ({
  serviceFeeSales: 0,
  serviceFeeCardTopUps: 0,
  serviceFeeCashTopUps: 0,
  serviceFeeRefunded: 0,
  platformSales: 0,
  platformSaldo: 0,
  ...o,
});

interface Local {
  V: string;
  slug: string;
  owner: string;
  lola: string;
  term: string;
  wallet: string;
  businessId: string | null;
}

/** Un local: dueño, chica, datáfono y un saldo con 1.000 € (para los consumos). */
async function local(tag: string, o: { fee?: boolean; platformBps?: number; createdAt?: Date; business?: boolean } = {}): Promise<Local> {
  const slug = `liq-${tag}-${r}`;
  return sys(async (tx) => {
    const business = o.business
      ? await tx.business.create({ data: { name: `Noches ${tag} S.L.`, taxId: `B${randomBytes(4).readUInt32BE(0).toString().padStart(10, '0').slice(0, 8)}` } })
      : null;
    const venue = await tx.venue.create({
      data: {
        name: `Sala ${tag}`,
        slug,
        platformCommissionBps: o.platformBps ?? 1000,
        serviceFeeEnabled: o.fee ?? false,
        businessId: business?.id ?? null,
        ...(o.createdAt ? { createdAt: o.createdAt } : {}),
      },
    });
    const V = venue.id;
    const owner = (await tx.user.create({ data: { tenantId: V, email: `own-${slug}@x.es`, passwordHash: 'x', role: 'OWNER' } })).id;
    const lola = (await tx.user.create({ data: { tenantId: V, email: `lola-${slug}@x.es`, passwordHash: 'x', role: 'OPERATOR' } })).id;
    const term = (await tx.terminal.create({ data: { tenantId: V, externalId: `LIQ-${tag}-${r}`, label: 'Barra' } })).id;
    const wallet = (await tx.clientWallet.create({ data: { tenantId: V, balanceCents: 100_000, qrToken: `liq-w-${slug}` } })).id;
    return { V, slug, owner, lola, term, wallet, businessId: business?.id ?? null };
  });
}

/** Un cobro pagado en `at` (como lo deja el aviso del banco): con o sin comisión del servicio, propina, % fijado y si es recarga. */
async function pay(l: Local, at: Date, o: { amount: number; fee?: number; tip?: number; bps?: number; topUp?: boolean; pos?: boolean }): Promise<string> {
  seq += 1;
  const fee = o.fee ?? 0;
  return sys(async (tx) =>
    (
      await tx.payment.create({
        data: {
          tenantId: l.V,
          terminalId: l.term,
          idempotencyKey: `liq-${r}-${seq}`,
          qrToken: `liq-${r}-${seq}-${randomBytes(3).toString('hex')}`,
          qrExpiresAt: at,
          amountCents: o.amount,
          serviceFeeCents: fee,
          serviceFeeBps: fee > 0 ? 1000 : null,
          tipCents: o.tip ?? 0,
          availableAmountCents: o.amount + fee + (o.tip ?? 0),
          status: 'AUTHORIZED',
          provider: 'REDSYS',
          providerTxId: `LIQ${seq}${randomBytes(3).toString('hex')}`,
          revenueCategory: 'VENUE_BAR',
          authorizedAt: at,
          createdAt: at,
          platformCommissionBps: o.bps ?? (fee > 0 ? 0 : 1000),
          walletId: o.topUp ? l.wallet : null,
          captureMethod: o.pos ? 'POS_EXTERNAL' : null,
        },
      })
    ).id,
  );
}

/** Gasto del saldo en `at`: `feeSaldo` = la parte pagada con saldo cargado con comisión del servicio (sin el % antiguo). */
async function consume(l: Local, at: Date, amount: number, feeSaldo = 0): Promise<string> {
  return sys(async (tx) =>
    (
      await tx.walletConsumption.create({
        data: { tenantId: l.V, walletId: l.wallet, amountCents: amount, providedByUserId: l.lola, category: 'VENUE_BAR', serviceFeeSaldoCents: feeSaldo, createdAt: at },
      })
    ).id,
  );
}

async function cashTopUp(l: Local, at: Date, amount: number, fee: number): Promise<void> {
  seq += 1;
  await sys((tx) =>
    tx.walletCashTopUp.create({
      data: {
        tenantId: l.V,
        walletId: l.wallet,
        amountCents: amount,
        serviceFeeCents: fee,
        serviceFeeBps: fee > 0 ? 1200 : null,
        takenByUserId: l.owner,
        idempotencyKey: `liq-cash-${r}-${seq}`,
        createdAt: at,
      },
    }),
  );
}

/** Devolución hecha en el banco el día `bankAt`, apuntada en `createdAt` (BBVA: días después), con su parte de comisión del servicio. */
async function refund(l: Local, paymentId: string, bankAt: Date, amount: number, fee: number, createdAt: Date = bankAt): Promise<void> {
  await sys((tx) =>
    tx.refund.create({
      data: {
        tenantId: l.V,
        paymentId,
        amountCents: amount,
        serviceFeeCents: fee,
        requestedBy: l.owner,
        status: 'SUCCEEDED',
        registeredManually: true,
        bankRefundedAt: bankAt,
        createdAt,
        reason: 'Devolución de prueba',
      },
    }),
  );
}

const generate = (l: Local, week: SettlementWeek, now: Date) => inVenue(undefined, () => settlements.generate(l.V, week, { now, auto: true }));

/** Lo que el mapa del dinero de esa ventana pone como de OxioPay (el mapa entero, no la cuenta de la liquidación). */
const mapOxioPay = (l: Local, w: { from: Date; to: Date }) =>
  inVenue(l.V, async () =>
    oxioPayCentsOf(await moneyMap.compute(l.V, { from: w.from, to: w.to }, { scope: { kind: 'period' }, now: w.to, openingFloatCents: null, withLiveBalances: false })),
  );

async function created(outcome: Awaited<ReturnType<typeof generate>>) {
  if (outcome.kind !== 'created') throw new Error(`se esperaba una liquidación nueva y salió ${outcome.kind}`);
  const id = outcome.id;
  return inVenue(undefined, () => settlements.detailForSuperAdmin(id));
}

const SA_ACTOR = { id: '', email: '', ip: '203.0.113.7', userAgent: 'vitest' };
const TOTP_SECRET = speakeasy.generateSecret({ length: 20 }).base32;
const totpAt = (step: number) => speakeasy.totp({ secret: TOTP_SECRET, encoding: 'base32', counter: step });

beforeAll(async () => {
  await prisma.onModuleInit();
  // El super-admin (su local y su 2FA de verdad, para la prueba del step-up).
  await sys(async (tx) => {
    const home = (await tx.venue.create({ data: { name: 'Casa del super', slug: `liq-home-${r}` } })).id;
    const u = await tx.user.create({
      data: {
        tenantId: home,
        email: `liq-super-${r}@x.es`,
        passwordHash: 'x',
        role: 'OWNER',
        isSuperAdmin: true,
        totpSecret: sealTotpSecret(TOTP_SECRET, process.env.ENCRYPTION_KEK),
      },
    });
    SA_ACTOR.id = u.id;
    SA_ACTOR.email = u.email;
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ─── La migración ───────────────────────────────────────────────────────

const MIGRATION = join(__dirname, '../../../../packages/db/prisma/migrations/20261031100000_liquidacion_oxiopay/migration.sql');
const CHECKS = [
  'oxiopay_settlements_period_order',
  'oxiopay_settlements_iso_week_range',
  'oxiopay_settlements_reference_format',
  'oxiopay_settlements_total_positive',
  'oxiopay_settlements_total_sum',
  'oxiopay_settlements_paid_range',
  'oxiopay_settlements_status_consistent',
  'oxiopay_settlements_breakdown_is_object',
  'oxiopay_settlements_manual_has_author',
  'oxiopay_settlement_payments_amount_positive',
  'oxiopay_settlement_payments_reference_length',
  'oxiopay_settlement_payments_reason_length',
  'oxiopay_payee_single_row',
  'oxiopay_payee_iban_format',
  'oxiopay_payee_names_length',
];

/** Lo que deja la migración (en una transacción de sistema: el SQL nombra tablas con FORCE RLS). */
async function schemaState() {
  return inVenue(undefined, () => prisma.asSystem((tx) => schemaStateIn(tx)));
}

async function schemaStateIn(tx: Parameters<Parameters<PrismaService['asSystem']>[0]>[0]) {
  const checks = await tx.$queryRawUnsafe<Array<{ name: string; valid: boolean }>>(
    `SELECT conname AS name, convalidated AS valid FROM pg_constraint WHERE conname = ANY($1::text[]) ORDER BY conname`,
    CHECKS,
  );
  const tables = await tx.$queryRawUnsafe<Array<{ relname: string; rls: boolean; forced: boolean }>>(
    `SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class
      WHERE relname IN ('oxiopay_settlements', 'oxiopay_settlement_payments', 'oxiopay_payee') ORDER BY relname`,
  );
  const indexes = await tx.$queryRawUnsafe<Array<{ def: string }>>(
    `SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'oxiopay_settlements_one_active_per_week'`,
  );
  return { checks, tables, indexes };
}

describe('la migración 20261031100000_liquidacion_oxiopay', () => {
  it('CHECK de importes y estados validados, RLS (FORCE en las del local) y una activa por local y semana', async () => {
    const s = await schemaState();
    expect(s.checks.map((x) => x.name).sort()).toEqual([...CHECKS].sort());
    expect(s.checks.every((x) => x.valid)).toBe(true);
    expect(s.tables).toEqual([
      { relname: 'oxiopay_payee', rls: true, forced: false },
      { relname: 'oxiopay_settlement_payments', rls: true, forced: true },
      { relname: 'oxiopay_settlements', rls: true, forced: true },
    ]);
    expect(s.indexes[0]?.def).toMatch(/UNIQUE INDEX.*\("tenantId", "periodFrom"\) WHERE \(status <> 'VOID'/);
  });

  it('se puede repetir: lo mismo, sin error', async () => {
    const before = await schemaState();
    const cli = join(__dirname, '../../../../packages/db/node_modules/prisma/build/index.js');
    const res = spawnSync(process.execPath, [cli, 'db', 'execute', '--url', String(process.env.DATABASE_URL), '--file', MIGRATION], {
      encoding: 'utf8',
      env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    });
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(await schemaState()).toEqual(before);
  }, 120_000);
});

// ─── Una semana normal: tres locales ────────────────────────────────────

/** Semana 42 de 2026: del lunes 12-oct 08:00 (06:00 UTC, verano) al lunes 19-oct 08:00. */
const W42 = weekStartingOn('2026-10-12');
const AFTER_W42 = T('2026-10-19T08:00:00Z'); // lunes 19-oct, 10:00 de Madrid

describe('semana normal: comisión del servicio encendida, apagada y saldo cargado antes de encenderla', () => {
  let on: Local;
  let off: Local;
  let mixed: Local;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    on = await local('on', { fee: true, business: true });
    off = await local('off');
    mixed = await local('mix', { fee: true });
    // Encendida: 33 € + 3,30 € + 2 € de propina (martes 13, 23:00 de Madrid); en el datáfono 20 € + 2 € (noche del jueves 15).
    const direct = await pay(on, T('2026-10-13T21:00:00Z'), { amount: 3_300, fee: 330, tip: 200 });
    await pay(on, T('2026-10-15T23:30:00Z'), { amount: 2_000, fee: 200, pos: true });
    // Recarga con tarjeta 50 € + 6 € (sábado 17) y en efectivo 100 € + 12 €.
    await pay(on, T('2026-10-17T20:00:00Z'), { amount: 5_000, fee: 600, topUp: true });
    await cashTopUp(on, T('2026-10-17T20:30:00Z'), 10_000, 1_200);
    // Gasta 33 € del saldo cargado con comisión: nada más para OxioPay.
    await consume(on, T('2026-10-17T22:00:00Z'), 3_300, 3_300);
    // Devolución de 11 € del cobro del martes, hecha dentro de la semana (sábado): 0,95 € de comisión.
    await refund(on, direct, T('2026-10-17T10:00:00Z'), 1_100, 95);
    // Apagada: el 10 % de siempre en los cobros y en el saldo.
    await pay(off, T('2026-10-14T22:00:00Z'), { amount: 3_300 });
    await pay(off, T('2026-10-16T00:30:00Z'), { amount: 2_000, pos: true });
    await consume(off, T('2026-10-16T01:00:00Z'), 3_000);
    // Encendida después de cargar saldo sin ella: 33 € del saldo, 20 € de lo cargado antes (10 % → 2 €).
    await consume(mixed, T('2026-10-18T00:00:00Z'), 3_300, 1_300);
    await pay(mixed, T('2026-10-18T00:30:00Z'), { amount: 3_300, fee: 330 });
  });

  it('encendida: la comisión del servicio cobrada (pagos y recargas) − devuelta; sin el % antiguo', async () => {
    const s = await created(await generate(on, W42, AFTER_W42));
    ids.on = s.id;
    expect(s.byConcept).toEqual(c({ serviceFeeSales: 530, serviceFeeCardTopUps: 600, serviceFeeCashTopUps: 1_200, serviceFeeRefunded: -95 }));
    expect(s).toMatchObject({ status: 'ISSUED', periodCents: 2_235, adjustmentsCents: 0, totalCents: 2_235, paidCents: 0, pendingCents: 2_235, isoWeek: 42, auto: true });
    expect(s.reference).toBe(`OXP-2026-S42-${on.slug.toUpperCase()}`);
    // Razón social y NIF del negocio, congelados.
    expect(s.party).toMatchObject({ venueName: 'Sala on', businessName: 'Noches on S.L.' });
    expect(s.party.businessTaxId).toMatch(/^B\d{8}$/);
    expect(s.business).toMatchObject({ id: on.businessId });
  });

  it('el total CUADRA con el mapa del dinero de la misma ventana (y por noche, con lo que da el mapa de cada noche)', async () => {
    for (const l of [on, off, mixed]) {
      const s = l === on ? await inVenue(undefined, () => settlements.detailForSuperAdmin(ids.on!)) : await created(await generate(l, W42, AFTER_W42));
      ids[l.slug] = s.id;
      expect(s.periodCents, l.slug).toBe(await mapOxioPay(l, W42));
      expect(s.moneyMapCents, l.slug).toBe(s.periodCents);
      expect(s.nights.map((n) => n.day)).toEqual(nightsOf(W42).map((n) => n.day));
      for (const n of s.nights) expect(n.totalCents, `${l.slug} ${n.day}`).toBe(await mapOxioPay(l, { from: T(n.from), to: T(n.to) }));
      expect(s.nights.reduce((a, n) => a + n.totalCents, 0)).toBe(s.periodCents);
    }
  });

  it('por noche: cada cobro en la noche de 08:00 a 08:00 en que cayó', async () => {
    const s = await inVenue(undefined, () => settlements.detailForSuperAdmin(ids.on!));
    const night = (day: string) => s.nights.find((n) => n.day === day)!.concepts;
    // El martes 13 a las 23:00 → noche del martes; el viernes 16 a las 01:30 → noche del jueves 15.
    expect(night('2026-10-13')).toEqual(c({ serviceFeeSales: 330 }));
    expect(night('2026-10-15')).toEqual(c({ serviceFeeSales: 200 }));
    expect(night('2026-10-17')).toEqual(c({ serviceFeeCardTopUps: 600, serviceFeeCashTopUps: 1_200, serviceFeeRefunded: -95 }));
  });

  it('apagada: la comisión de plataforma de siempre (cobros y saldo); encendida con saldo de antes: el % solo sobre lo cargado sin ella', async () => {
    const offS = await inVenue(undefined, () => settlements.detailForSuperAdmin(ids[off.slug]!));
    expect(offS.byConcept).toEqual(c({ platformSales: 330 + 200, platformSaldo: 300 }));
    expect(offS.totalCents).toBe(830);
    const mixS = await inVenue(undefined, () => settlements.detailForSuperAdmin(ids[mixed.slug]!));
    expect(mixS.byConcept).toEqual(c({ serviceFeeSales: 330, platformSaldo: 200 }));
    expect(mixS.totalCents).toBe(530);
  });

  it('idempotente: generarla otra vez da la misma; el documento y el CSV llevan la referencia y los importes', async () => {
    const again = await generate(on, W42, AFTER_W42);
    expect(again).toEqual({ kind: 'exists', id: ids.on, reference: `OXP-2026-S42-${on.slug.toUpperCase()}` });
    const s = await inVenue(undefined, () => settlements.detailForSuperAdmin(ids.on!));
    const html = settlementDocumentHtml(s, AFTER_W42);
    expect(html).toContain(s.reference);
    expect(html).toContain('22,35\u00a0€');
    expect(settlementCsv(s)).toContain(';Total a pagar;;;;22,35');
  });

  it('pagada en parte (con motivo) y luego entera; anular con pagos no se puede', async () => {
    const id = ids.on!;
    const pending = (await inVenue(undefined, () => sa.list({ status: 'OPEN' }))).totals.pendingCents;
    await expect(
      inVenue(undefined, () => sa.recordPayment(SA_ACTOR, id, { amountCents: 1_000, paidOn: '2026-10-20', bankReference: 'TRF-1', totpCode: '123456' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      inVenue(undefined, () => sa.recordPayment(SA_ACTOR, id, { amountCents: 3_000, paidOn: '2026-10-20', bankReference: 'TRF-1', reason: 'De más', totpCode: '123456' })),
    ).rejects.toThrow(/mayor que lo pendiente/);
    const part = await inVenue(undefined, () =>
      sa.recordPayment(SA_ACTOR, id, { amountCents: 1_000, paidOn: '2026-10-20', bankReference: 'TRF-1', reason: 'Pagó a cuenta', totpCode: '123456' }),
    );
    expect(part).toMatchObject({ status: 'PARTIALLY_PAID', paidCents: 1_000, pendingCents: 1_235 });
    expect(part.payments).toMatchObject([{ amountCents: 1_000, paidOn: '2026-10-20', bankReference: 'TRF-1', reason: 'Pagó a cuenta', recordedByEmail: SA_ACTOR.email }]);
    // Lo pendiente de cobrar de la consola baja lo pagado.
    expect((await inVenue(undefined, () => sa.list({ status: 'OPEN' }))).totals.pendingCents).toBe(pending - 1_000);
    await expect(inVenue(undefined, () => sa.void(SA_ACTOR, id, { reason: 'Mal', totpCode: '123456' }))).rejects.toBeInstanceOf(ConflictException);
    const paid = await inVenue(undefined, () => sa.recordPayment(SA_ACTOR, id, { amountCents: 1_235, paidOn: '2026-10-21', bankReference: 'TRF-2', totpCode: '123456' }));
    expect(paid).toMatchObject({ status: 'PAID', paidCents: 2_235, pendingCents: 0 });
    await expect(
      inVenue(undefined, () => sa.recordPayment(SA_ACTOR, id, { amountCents: 1, paidOn: '2026-10-21', bankReference: 'TRF-3', reason: 'Otra', totpCode: '123456' })),
    ).rejects.toBeInstanceOf(ConflictException);
    const events = await sys((tx) => tx.auditEvent.findMany({ where: { targetId: id, action: { startsWith: 'superadmin.settlement.' } }, orderBy: { id: 'asc' } }));
    expect(events.map((e) => e.action)).toEqual(['superadmin.settlement.generated', 'superadmin.settlement.paid_partially', 'superadmin.settlement.paid']);
    expect(events[1]).toMatchObject({ actorId: SA_ACTOR.id, tenantId: on.V, payload: expect.objectContaining({ reason: 'Pagó a cuenta', matchesPending: false }) });
  });

  it('anulada (sin pagos, con motivo) y regenerada: -2, con las mismas cifras; la anulada sigue en el registro', async () => {
    const old = ids[off.slug]!;
    const voided = await inVenue(undefined, () => sa.void(SA_ACTOR, old, { reason: 'Faltaba un cobro', totpCode: '123456' }));
    expect(voided).toMatchObject({ status: 'VOID', pendingCents: 0, voidReason: 'Faltaba un cobro' });
    await expect(inVenue(undefined, () => sa.void(SA_ACTOR, old, { reason: 'Otra vez', totpCode: '123456' }))).rejects.toBeInstanceOf(ConflictException);
    // El repaso automático no la regenera (si nadie lo hace, entra la semana siguiente como ajuste).
    expect(await generate(off, W42, AFTER_W42)).toMatchObject({ kind: 'voided', id: old });
    const fresh = await inVenue(undefined, () => sa.generate(SA_ACTOR, { venueId: off.V, week: '2026-10-12', reason: 'Rehecha', totpCode: '123456' }, AFTER_W42));
    expect(fresh).toMatchObject({ reference: `OXP-2026-S42-${off.slug.toUpperCase()}-2`, totalCents: 830, replacesId: old, auto: false, status: 'ISSUED' });
    const err = await inVenue(undefined, () => sa.generate(SA_ACTOR, { venueId: off.V, week: '2026-10-12', totpCode: '123456' }, AFTER_W42)).catch((e: unknown) => e);
    expect(((err as ConflictException).getResponse() as { code: string }).code).toBe('SETTLEMENT_EXISTS');
    const actions = await sys((tx) => tx.auditEvent.findMany({ where: { tenantId: off.V, action: { startsWith: 'superadmin.settlement.' } }, orderBy: { id: 'asc' } }));
    expect(actions.map((e) => e.action)).toEqual(['superadmin.settlement.generated', 'superadmin.settlement.voided', 'superadmin.settlement.regenerated']);
    expect(actions[1]?.payload).toMatchObject({ reason: 'Faltaba un cobro' });
  });

  it('la base asegura sola los importes, los estados y que un pago no se reescribe', async () => {
    const asBypass = (sql: string) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
        await tx.$executeRawUnsafe(sql);
      }).then(() => null, (e: unknown) => String((e as Error).message));
    expect(await asBypass(`UPDATE oxiopay_settlements SET "paidCents" = "totalCents" + 1 WHERE id = '${ids.on}'`)).toMatch(/oxiopay_settlements_paid_range/);
    expect(await asBypass(`UPDATE oxiopay_settlements SET status = 'ISSUED' WHERE id = '${ids.on}'`)).toMatch(/oxiopay_settlements_status_consistent/);
    expect(await asBypass(`UPDATE oxiopay_settlements SET "totalCents" = 1 WHERE id = '${ids.on}'`)).toMatch(/oxiopay_settlements_(total_sum|paid_range)/);
    expect(await asBypass(`UPDATE oxiopay_settlement_payments SET "amountCents" = 1 WHERE "settlementId" = '${ids.on}'`)).toMatch(/solo de añadir/);
    expect(await asBypass(`DELETE FROM oxiopay_settlement_payments WHERE "settlementId" = '${ids.on}'`)).toMatch(/solo de añadir/);
    // Una segunda activa de la misma semana: no.
    expect(
      await asBypass(
        `INSERT INTO oxiopay_settlements ("tenantId", "periodFrom", "periodTo", "isoYear", "isoWeek", reference, "periodCents", "totalCents", "moneyMapCents", breakdown)
         SELECT "tenantId", "periodFrom", "periodTo", "isoYear", "isoWeek", reference || '-9', "periodCents", "totalCents", "moneyMapCents", breakdown
           FROM oxiopay_settlements WHERE id = '${ids.on}'`,
      ),
      // 23505: clave única (el índice parcial de una activa por local y semana).
    ).toMatch(/23505/);
  });
});

// ─── El cambio de hora y la noche que cruza el corte del lunes ──────────

/** Semana 43 de 2026: del lunes 19-oct 08:00 (06:00 UTC) al lunes 26-oct 08:00 (07:00 UTC, ya en invierno): 169 h. */
const W43 = weekStartingOn('2026-10-19');
const W44 = weekStartingOn('2026-10-26');

describe('cambio de hora (domingo 25-oct-2026) y la noche que cruza el corte', () => {
  let l: Local;

  beforeAll(async () => {
    l = await local('dst', { fee: true });
    // Las 02:30 del domingo pasan dos veces (00:30 y 01:30 UTC): las dos, de la noche del sábado 24.
    await pay(l, T('2026-10-25T00:30:00Z'), { amount: 1_000, fee: 100 });
    await pay(l, T('2026-10-25T01:30:00Z'), { amount: 1_000, fee: 100 });
    // La noche del domingo 25 abierta de 22:00 a 09:00 (cierre manual pasado el corte):
    // 07:59 de Madrid (06:59 UTC) es de la semana 43; 08:30 (07:30 UTC), de la 44.
    await pay(l, T('2026-10-26T06:59:59Z'), { amount: 500, fee: 50 });
    await pay(l, T('2026-10-26T07:30:00Z'), { amount: 700, fee: 70 });
    await sys((tx) =>
      tx.venueNight.create({ data: { tenantId: l.V, openedAt: T('2026-10-25T21:00:00Z'), closedAt: T('2026-10-26T08:00:00Z'), openedBy: l.owner, openingFloatCents: 0 } }),
    );
  });

  it('la semana de 169 h: la noche del sábado (25 h) con los dos cobros de las 02:30; cuadra con el mapa', async () => {
    const s = await created(await generate(l, W43, T('2026-10-26T09:00:00Z')));
    expect(T(s.periodTo).getTime() - T(s.periodFrom).getTime()).toBe(169 * 3_600_000);
    expect(s.periodFrom).toBe('2026-10-19T06:00:00.000Z');
    expect(s.periodTo).toBe('2026-10-26T07:00:00.000Z');
    const sat = s.nights.find((n) => n.day === '2026-10-24')!;
    expect(T(sat.to).getTime() - T(sat.from).getTime()).toBe(25 * 3_600_000);
    expect(sat.concepts.serviceFeeSales).toBe(200);
    expect(s.nights.find((n) => n.day === '2026-10-25')!.concepts.serviceFeeSales).toBe(50);
    expect(s.totalCents).toBe(250);
    expect(s.periodCents).toBe(await mapOxioPay(l, W43));
  });

  it('el lunes antes de las 10:00 de Madrid aún no toca (09:59 → nada), a las 10:00 sí', async () => {
    const early = await inVenue(undefined, () => settlements.runDue(T('2026-11-02T08:59:00Z')));
    expect(early.week).toBeNull();
  });

  it('la noche que cruza el corte se reparte: lo de antes de las 08:00 en la 43, lo de después en la 44 (y suman lo de esa noche)', async () => {
    const s44 = await created(await generate(l, W44, T('2026-11-02T09:00:00Z')));
    expect(s44.nights[0]).toMatchObject({ day: '2026-10-26', concepts: c({ serviceFeeSales: 70 }) });
    expect(s44.adjustments).toEqual([]);
    expect(s44.totalCents).toBe(70);
    expect(s44.periodCents).toBe(await mapOxioPay(l, W44));
    // El mapa de la noche (su ventana de apertura a cierre) = el domingo de la 43 + el lunes de la 44.
    const night = await sys((tx) => tx.venueNight.findFirstOrThrow({ where: { tenantId: l.V } }));
    const ofNight = await inVenue(l.V, () => moneyMap.forQuery(l.V, { night: night.id }, T('2026-11-02T09:00:00Z')));
    expect(oxioPayCentsOf(ofNight)).toBe(50 + 70);
  });
});

// ─── Devolución dentro y después del congelado ──────────────────────────

const W45 = weekStartingOn('2026-11-02');
const W46 = weekStartingOn('2026-11-09');
const W47 = weekStartingOn('2026-11-16');

describe('devolución dentro de la semana y otra apuntada tarde con fecha de la semana ya liquidada', () => {
  let l: Local;
  let s45: string;
  let direct: string;

  beforeAll(async () => {
    l = await local('tarde', { fee: true });
    // Martes 3-nov 22:00: 33 € + 3,30 € + 2 € (38,30 €).
    direct = await pay(l, T('2026-11-03T21:00:00Z'), { amount: 3_300, fee: 330, tip: 200 });
    // Dentro de la semana (jueves 5): 11 € devueltos, 0,95 € de comisión.
    await refund(l, direct, T('2026-11-05T12:00:00Z'), 1_100, 95);
  });

  it('dentro del congelado: la semana ya la descuenta', async () => {
    const s = await created(await generate(l, W45, T('2026-11-09T09:00:00Z')));
    s45 = s.id;
    expect(s.byConcept).toEqual(c({ serviceFeeSales: 330, serviceFeeRefunded: -95 }));
    expect(s.totalCents).toBe(235);
  });

  it('después del congelado: la liquidación de la 45 no cambia; entra en la 46 como ajuste, con su semana, noche y referencia', async () => {
    // Devolución de BBVA apuntada el martes 10 con fecha del viernes 6 (semana 45, ya liquidada).
    await refund(l, direct, T('2026-11-06T10:00:00Z'), 1_100, 95, T('2026-11-10T10:00:00Z'));
    // Y otra hecha en la semana 46 (miércoles 11) del cobro de la 45: es de la 46, no un ajuste.
    await refund(l, direct, T('2026-11-11T12:00:00Z'), 550, 47);
    await pay(l, T('2026-11-11T21:00:00Z'), { amount: 3_300, fee: 330 });
    const frozen = await inVenue(undefined, () => settlements.detailForSuperAdmin(s45));
    expect(frozen).toMatchObject({ totalCents: 235, periodCents: 235, adjustmentsCents: 0 });
    // El mapa de la 45, ahora, ya da 0,95 € menos: lo que irá de ajuste.
    expect(await mapOxioPay(l, W45)).toBe(140);

    const s46 = await created(await generate(l, W46, T('2026-11-16T09:00:00Z')));
    expect(s46.periodCents).toBe(330 - 47);
    expect(s46.periodCents).toBe(await mapOxioPay(l, W46));
    expect(s46.adjustments).toEqual([
      { weekFrom: '2026-11-02', isoYear: 2026, isoWeek: 45, reference: frozen.reference, day: '2026-11-06', concept: 'serviceFeeRefunded', amountCents: -95 },
    ]);
    expect(s46).toMatchObject({ adjustmentsCents: -95, totalCents: 330 - 47 - 95 });
    // Con el tiempo cuadra: lo liquidado de la 45 (235 − 95) es lo que da su mapa.
    expect(frozen.totalCents + s46.adjustmentsCents).toBe(await mapOxioPay(l, W45));
  });

  it('la semana siguiente sin nada: no se crea (ni repite el ajuste)', async () => {
    expect(await generate(l, W47, T('2026-11-23T09:00:00Z'))).toEqual({ kind: 'nothing', totalCents: 0 });
  });
});

// ─── Lo que ve cada local, y el 2FA de verdad ───────────────────────────

describe('permisos: el dueño solo lo suyo (y solo lectura); la consola, con 2FA de verdad', () => {
  let a: Local;
  let b: Local;
  let sa1: string;
  let sb1: string;
  const W = weekStartingOn('2026-11-30');

  beforeAll(async () => {
    a = await local('perm-a', { fee: true });
    b = await local('perm-b', { fee: true });
    await pay(a, T('2026-12-01T21:00:00Z'), { amount: 1_000, fee: 100 });
    await pay(b, T('2026-12-01T21:00:00Z'), { amount: 2_000, fee: 200 });
    sa1 = (await created(await generate(a, W, T('2026-12-07T09:00:00Z')))).id;
    sb1 = (await created(await generate(b, W, T('2026-12-07T09:00:00Z')))).id;
  });

  it('el dueño de A ve las de A y no las de B (ni en la lista ni por id); RLS de la base aunque la consulta no filtre', async () => {
    const page = await inVenue(a.V, () => settlements.listForOwner(a.V));
    expect(page.items.map((i) => i.id)).toEqual([sa1]);
    await expect(inVenue(a.V, () => settlements.detailForOwner(a.V, sb1))).rejects.toBeInstanceOf(NotFoundException);
    expect((await inVenue(a.V, () => settlements.detailForOwner(a.V, sa1))).payments).toEqual([]);
    const visible = await prisma.withTenant(a.V, (tx) =>
      tx.$queryRawUnsafe<Array<{ t: string }>>(`SELECT "tenantId"::text AS t FROM oxiopay_settlements WHERE id = ANY($1::uuid[])`, [sa1, sb1]),
    );
    expect(visible.map((v) => v.t)).toEqual([a.V]);
  });

  it('apuntar un pago con un código 2FA malo: 403 TOTP_INVALID, al registro y sin pago; con el bueno, se apunta', async () => {
    const redis = createFakeRedis();
    redis.defineScript(CLAIM_STEP_LUA, claimStepScript);
    const totp = new TotpService(prisma as never, new TotpAttemptsService(new LockoutService(redis as never), redis as never));
    const real = new SuperAdminSettlementsService(settlements, new SuperAdminStepUpService(totp, saAudit), saAudit);
    const body = { amountCents: 100, paidOn: '2026-12-08', bankReference: 'TRF-A' };
    const step = totpStepAt(Date.now());
    const wrong = await inVenue(undefined, () => real.recordPayment(SA_ACTOR, sa1, { ...body, totpCode: totpAt(step - 5) }, T('2026-12-08T10:00:00Z'))).catch(
      (e: unknown) => e,
    );
    expect(((wrong as { getResponse(): { code: string } }).getResponse()).code).toBe('TOTP_INVALID');
    expect((await inVenue(undefined, () => settlements.detailForSuperAdmin(sa1))).payments).toEqual([]);
    const failed = await sys((tx) => tx.auditEvent.findFirst({ where: { actorId: SA_ACTOR.id, action: 'superadmin.step_up.failed' }, orderBy: { id: 'desc' } }));
    expect(failed?.payload).toMatchObject({ attempted: 'settlement.pay' });
    const ok = await inVenue(undefined, () => real.recordPayment(SA_ACTOR, sa1, { ...body, totpCode: totpAt(step) }, T('2026-12-08T10:00:00Z')));
    expect(ok).toMatchObject({ status: 'PAID', paidCents: 100 });
  });

  it('la fecha del pago no puede ser futura ni anterior a la semana', async () => {
    await expect(
      inVenue(undefined, () => sa.recordPayment(SA_ACTOR, sb1, { amountCents: 200, paidOn: '2026-12-09', bankReference: 'x', totpCode: '123456' }, T('2026-12-08T10:00:00Z'))),
    ).rejects.toThrow(/futura/);
    await expect(
      inVenue(undefined, () => sa.recordPayment(SA_ACTOR, sb1, { amountCents: 200, paidOn: '2026-11-29', bankReference: 'x', totpCode: '123456' }, T('2026-12-08T10:00:00Z'))),
    ).rejects.toThrow(/anterior a la semana/);
  });
});

// ─── El repaso del lunes con dos réplicas ───────────────────────────────

/** El Redis compartido por las réplicas (SET NX/EX, EXISTS, DEL y el candado). */
function sharedRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(async (key: string, value: string, ...opts: Array<string | number>) => {
      if (opts.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    eval: vi.fn(async (script: string, _n: number, key: string, value: string) => {
      if (script !== RELEASE_LOCK_LUA) throw new Error('script inesperado');
      if (store.get(key) !== value) return 0;
      store.delete(key);
      return 1;
    }),
  };
}

describe('repaso del lunes: dos réplicas a la vez (candado SET NX) y sin candado (la base)', () => {
  // Locales «de 2020»: el repaso de esa semana solo ve a estos (los demás de las pruebas son de ahora).
  const OLD = T('2020-01-01T00:00:00Z');
  const W2020 = weekStartingOn('2020-02-24');
  const MONDAY = T('2020-03-02T09:30:00Z'); // lunes 2-mar-2020, 10:30 de Madrid
  let x: Local;
  let y: Local;

  beforeAll(async () => {
    x = await local('cron-x', { fee: true, createdAt: OLD });
    y = await local('cron-y', { createdAt: OLD });
    await pay(x, T('2020-02-25T21:00:00Z'), { amount: 3_300, fee: 330 });
    await pay(y, T('2020-02-26T21:00:00Z'), { amount: 2_000 });
  });

  it('dos réplicas con el mismo Redis: una genera, la otra no; una por local; la marca evita repetir', async () => {
    const redis = sharedRedis();
    const telegram = { isConfigured: () => false, send: vi.fn() };
    const one = new OxioPaySettlementsCron(settlements, redis as never, telegram as never);
    const two = new OxioPaySettlementsCron(settlements, redis as never, telegram as never);
    await inVenue(undefined, () => Promise.all([one.tick(MONDAY), two.tick(MONDAY)]));
    await inVenue(undefined, () => Promise.all([one.tick(new Date(MONDAY.getTime() + 600_000)), two.tick(new Date(MONDAY.getTime() + 600_000))]));
    const rows = await sys((tx) => tx.oxioPaySettlement.findMany({ where: { tenantId: { in: [x.V, y.V] } } }));
    expect(rows.map((s) => [s.tenantId, s.totalCents, s.status, s.auto]).sort()).toEqual(
      [
        [x.V, 330, 'ISSUED', true],
        [y.V, 200, 'ISSUED', true],
      ].sort(),
    );
    expect(redis.store.get(`np:oxiopay-settlements:done:${W2020.monday}`)).toBe('1');
    const generated = await sys((tx) => tx.auditEvent.count({ where: { tenantId: { in: [x.V, y.V] }, action: 'superadmin.settlement.generated' } }));
    expect(generated).toBe(2);
  });

  it('sin candado (Redis vacío) y a la vez: la base no deja dos; la segunda devuelve la de la primera', async () => {
    const z = await local('cron-z', { fee: true, createdAt: OLD });
    await pay(z, T('2020-02-27T21:00:00Z'), { amount: 1_000, fee: 100 });
    const outs = await inVenue(undefined, () => Promise.all([0, 1, 2].map(() => settlements.generate(z.V, W2020, { now: MONDAY, auto: true }))));
    expect(outs.filter((o) => o.kind === 'created')).toHaveLength(1);
    expect(outs.filter((o) => o.kind === 'exists')).toHaveLength(2);
    expect(await sys((tx) => tx.oxioPaySettlement.count({ where: { tenantId: z.V } }))).toBe(1);
  });
});

// ─── Sin pagar 7 días: Telegram y el panel del dueño; la cuenta de OxioPay ─

describe('aviso de 7 días sin pagar y la cuenta de OxioPay', () => {
  let l: Local;
  let id: string;
  const W = weekStartingOn('2027-01-04');

  beforeAll(async () => {
    l = await local('aviso', { fee: true });
    await pay(l, T('2027-01-05T21:00:00Z'), { amount: 2_000, fee: 200 });
    id = (await created(await generate(l, W, T('2027-01-11T09:00:00Z')))).id;
  });

  it('a los 7 días aún no; pasados, en el aviso del dueño, en la consola y por Telegram una vez al día', async () => {
    expect((await inVenue(l.V, () => settlements.noticeForOwner(l.V, T('2027-01-18T09:00:00Z')))).overdue).toEqual([]);
    const later = T('2027-01-19T11:00:00Z');
    const notice = await inVenue(l.V, () => settlements.noticeForOwner(l.V, later));
    expect(notice).toMatchObject({ overdueCents: 200, overdue: [{ id, pendingCents: 200, daysOpen: 8 }] });
    const page = await inVenue(undefined, () => settlements.listForSuperAdmin({ venueId: l.V }, later));
    expect(page.items[0]).toMatchObject({ id, overdue: true, daysOpen: 8 });
    expect(page.totals.overdueCount).toBeGreaterThanOrEqual(1);
    const redis = sharedRedis();
    redis.store.set(`np:oxiopay-settlements:done:2027-01-11`, '1');
    const telegram = { isConfigured: () => true, send: vi.fn(async () => true) };
    const cron = new OxioPaySettlementsCron(settlements, redis as never, telegram as never);
    await inVenue(undefined, () => cron.tick(later));
    await inVenue(undefined, () => cron.tick(new Date(later.getTime() + 600_000)));
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(telegram.send.mock.calls[0]![0]).toContain('Liquidaciones sin pagar (más de 7 días)');
    const listed = await inVenue(undefined, () => settlements.overdueList(later));
    expect(listed).toContainEqual({ reference: `OXP-2027-S01-${l.slug.toUpperCase()}`, venueName: 'Sala aviso', pendingCents: 200, daysOpen: 8 });
  });

  it('sin la cuenta de OxioPay: se emite igual y avisa; puesta por el super-admin (IBAN tapado en el registro), el dueño la ve', async () => {
    await sys((tx) => tx.oxioPayPayee.deleteMany({}));
    expect((await inVenue(undefined, () => sa.list({ venueId: l.V }))).payeeMissing).toBe(true);
    expect((await inVenue(l.V, () => settlements.detailForOwner(l.V, id))).payee).toBeNull();
    const payee = await inVenue(undefined, () => sa.setPayee(SA_ACTOR, { name: 'OxioPay S.L.', iban: 'ES9121000418450200051332', holder: 'OxioPay Pagos S.L.', totpCode: '123456' }));
    expect(payee).toMatchObject({ iban: 'ES9121000418450200051332', holder: 'OxioPay Pagos S.L.' });
    const owner = await inVenue(l.V, () => settlements.listForOwner(l.V));
    expect(owner.payee).toMatchObject({ name: 'OxioPay S.L.', iban: 'ES9121000418450200051332' });
    expect(owner.pendingCents).toBe(200);
    const event = await sys((tx) => tx.auditEvent.findFirst({ where: { action: 'superadmin.settlement.payee_updated', actorId: SA_ACTOR.id }, orderBy: { id: 'desc' } }));
    expect(JSON.stringify(event?.payload)).not.toContain('ES9121000418450200051332');
    expect(JSON.stringify(event?.payload)).toContain('ES91 •••• •••• 1332');
    // El CHECK de la base: IBAN como lo guarda el API.
    await expect(sys((tx) => tx.oxioPayPayee.update({ where: { id: 1 }, data: { iban: 'es91 2100' } }))).rejects.toThrow(/oxiopay_payee_iban_format/);
  });
});

/** Los conceptos de una liquidación suman su total (nunca un céntimo suelto). */
describe('cuadre interno', () => {
  it('en todas las liquidaciones de esta prueba: conceptos = total, noches + ajustes = total', async () => {
    const rows = await sys((tx) => tx.oxioPaySettlement.findMany({ where: { reference: { contains: r.toUpperCase() } }, select: { id: true } }));
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) {
      const s = await inVenue(undefined, () => settlements.detailForSuperAdmin(row.id));
      expect(conceptsTotal(s.byConcept)).toBe(s.totalCents);
      expect(s.nights.reduce((a, n) => a + n.totalCents, 0) + s.adjustments.reduce((a, x) => a + x.amountCents, 0)).toBe(s.totalCents);
      // Lo pagado es la suma de sus pagos apuntados.
      expect(s.payments.reduce((a, p) => a + p.amountCents, 0)).toBe(s.paidCents);
    }
  });
});
