import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import {
  conceptsTotal,
  isOpenSettlement,
  settlementPaymentProblem,
  settlementPendingCents,
  settlementStatusAfterPayment,
  type OwnerSettlementNotice,
  type OwnerSettlementPage,
  type OxioPayPayee,
  type RecordSettlementPaymentDto,
  type SetOxioPayPayeeDto,
  type SettlementAdjustment,
  type SettlementDetail,
  type SettlementListItem,
  type SettlementListQuery,
  type SettlementNight,
  type SettlementParty,
  type SuperAdminSettlementPage,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { madridDay, madridStartOfDay, nextDay } from '../../common/time/madrid';
import { AuditService } from '../audit/audit.service';
import { MoneyMapService } from '../money-map/money-map.service';
import {
  adjustmentLines,
  breakdownOf,
  daysOpen,
  isOverdue,
  ledgerOf,
  ledgerTotal,
  periodNights,
  sameConcepts,
  settlementTotals,
  StoredBreakdownSchema,
  type RecomputedWeek,
  type SettlementTotals,
  type StoredBreakdown,
} from './settlement-rules';
import { dueWeek, nightsOf, previousWeeks, settlementReference, weekStartingOn, type SettlementWeek } from './settlement-week';

/**
 * Semanas anteriores que se repasan al generar, por si algo se apuntó tarde
 * con su fecha (una devolución del banco, un aviso que llegó tarde, un
 * consumo anulado). Lo de más atrás ya no entra (docs/SUPERADMIN.md).
 */
export const LOOKBACK_WEEKS = 12;
/** Reintentos si otra liquidación del local cambia mientras se calcula. */
const MAX_ATTEMPTS = 3;
const LIST_LIMIT = 200;
const NOT_FOUND = 'Liquidación no encontrada';

/** Quién la genera a mano o apunta un pago (el super-admin). */
export interface SettlementActor {
  id: string;
  email: string;
}

export type GenerateOutcome =
  | { kind: 'created'; id: string; reference: string; totalCents: number; replacesId: string | null }
  | { kind: 'exists'; id: string; reference: string }
  /** El repaso no regenera una semana anulada por el super-admin (lo hace él a mano, o entra como ajuste). */
  | { kind: 'voided'; id: string; reference: string }
  | { kind: 'nothing'; totalCents: number };

type SettlementRow = Prisma.OxioPaySettlementGetPayload<Record<string, never>>;
type SettlementWithPayments = Prisma.OxioPaySettlementGetPayload<{ include: { payments: true } }>;

interface Plan {
  venueId: string;
  businessId: string | null;
  week: SettlementWeek;
  breakdown: StoredBreakdown;
  nights: SettlementNight[];
  adjustments: SettlementAdjustment[];
  totals: SettlementTotals;
  moneyMapCents: number;
  reference: string;
  replacesId: string | null;
  horizonFrom: Date;
  /** Las liquidaciones no anuladas con las que se calculó (si cambian, se recalcula). */
  fingerprint: string;
}

const logger = new Logger('OxioPaySettlements');

/** Otra liquidación del local cambió mientras se calculaba: se vuelve a calcular. */
class StaleLedgerError extends Error {}

const fingerprintOf = (rows: ReadonlyArray<{ id: string }>): string =>
  rows
    .map((r) => r.id)
    .sort()
    .join(',');

/**
 * «Liquidación OxioPay»: lo que cada local debe a OxioPay por semana (lunes
 * 08:00 → lunes 08:00 de Madrid). Las cifras salen del mapa del dinero
 * (MoneyMapService.oxioPayOwed, las mismas filas y cuentas): por eso el total
 * de una semana cuadra con lo que el mapa da para esa ventana. Al generarla
 * se congela; lo apuntado tarde con fecha de una semana ya liquidada va a la
 * siguiente como «ajustes de semanas anteriores» (settlement-rules.ts).
 * Las escrituras van con el local bloqueado (candado de transacción): el
 * repaso de dos réplicas o el super-admin a la vez no duplican nada (y una
 * activa por local y semana lo asegura además la base).
 */
@Injectable()
export class OxioPaySettlementsService {
  private readonly logger = new Logger(OxioPaySettlementsService.name);
  private readonly prisma: PrismaService;
  private readonly moneyMap: MoneyMapService;
  private readonly audit: AuditService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(MoneyMapService) moneyMap: MoneyMapService,
    @Inject(AuditService) audit: AuditService,
  ) {
    this.prisma = prisma;
    this.moneyMap = moneyMap;
    this.audit = audit;
  }

  // ─── Generación ────────────────────────────────────────────────────────

  /**
   * El repaso del lunes: la semana terminada de cada local (si es lunes antes
   * de las 10:00, nada). Cada local por separado: un fallo no corta los demás.
   */
  async runDue(now: Date = new Date()): Promise<{ week: SettlementWeek | null; created: string[]; failed: string[] }> {
    const week = dueWeek(now);
    if (!week) return { week: null, created: [], failed: [] };
    const venues = await this.prisma.acrossVenues((tx) =>
      tx.venue.findMany({
        where: { createdAt: { lt: week.to }, OR: [{ deletedAt: null }, { deletedAt: { gte: week.from } }] },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    const created: string[] = [];
    const failed: string[] = [];
    for (const venue of venues) {
      try {
        const outcome = await this.generate(venue.id, week, { now, auto: true });
        if (outcome.kind === 'created') created.push(outcome.reference);
      } catch (err) {
        failed.push(`${venue.id}: ${(err as Error).message}`);
      }
    }
    if (created.length > 0 && !(await this.payee())) {
      this.logger.warn('Liquidaciones OxioPay emitidas sin la cuenta de OxioPay (Super admin → Liquidaciones → Cuenta de OxioPay)');
    }
    return { week, created, failed };
  }

  /**
   * La liquidación de un local y una semana ya terminada. Si ya hay una
   * activa, esa (no se duplica); si no hay nada que liquidar, no se crea.
   */
  async generate(
    venueId: string,
    week: SettlementWeek,
    opts: { now: Date; auto: boolean; actor?: SettlementActor },
  ): Promise<GenerateOutcome> {
    if (week.to.getTime() > opts.now.getTime()) throw new BadRequestException('Esa semana aún no ha terminado (acaba el lunes a las 08:00)');
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const plan = await this.plan(venueId, week, opts.auto);
      if ('kind' in plan) return plan;
      if (plan.totals.totalCents <= 0) return { kind: 'nothing', totalCents: plan.totals.totalCents };
      try {
        const row = await this.insert(plan, opts);
        // La del repaso, al registro aquí (la del super-admin la apunta la consola, con quién, IP y motivo).
        if (opts.auto) {
          await this.audit.log({
            action: 'superadmin.settlement.generated',
            tenantId: venueId,
            targetType: 'OxioPaySettlement',
            targetId: row.id,
            payload: { auto: true, reference: row.reference, week: week.monday, periodCents: row.periodCents, adjustmentsCents: row.adjustmentsCents, totalCents: row.totalCents },
          });
        }
        return { kind: 'created', id: row.id, reference: row.reference, totalCents: row.totalCents, replacesId: plan.replacesId };
      } catch (err) {
        if (err instanceof StaleLedgerError) continue;
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const existing = await this.activeFor(venueId, week);
          if (existing) return { kind: 'exists', id: existing.id, reference: existing.reference };
        }
        throw err;
      }
    }
    throw new ConflictException('Las liquidaciones de este local cambiaron a la vez: vuelve a probar');
  }

  private async activeFor(venueId: string, week: SettlementWeek): Promise<{ id: string; reference: string } | null> {
    return this.prisma.acrossVenues((tx) =>
      tx.oxioPaySettlement.findFirst({
        where: { tenantId: venueId, periodFrom: week.from, status: { not: 'VOID' } },
        select: { id: true, reference: true },
      }),
    );
  }

  /** Lo que tendría la liquidación ahora (sin guardar nada). */
  private async plan(
    venueId: string,
    week: SettlementWeek,
    auto: boolean,
  ): Promise<Plan | { kind: 'exists' | 'voided'; id: string; reference: string }> {
    const venue = await this.prisma.acrossVenues((tx) =>
      tx.venue.findUnique({
        where: { id: venueId },
        select: { id: true, name: true, slug: true, platformCommissionBps: true, businessId: true, business: { select: { name: true, taxId: true } } },
      }),
    );
    if (!venue) throw new NotFoundException('Local no encontrado');
    const lookbackWeeks = previousWeeks(week, LOOKBACK_WEEKS);
    const horizonFrom = lookbackWeeks[lookbackWeeks.length - 1]!.from;
    const { rows, start } = await this.prisma.acrossVenues(async (tx) => ({
      rows: await tx.oxioPaySettlement.findMany({
        where: { tenantId: venueId, periodFrom: { gte: horizonFrom } },
        select: { id: true, status: true, periodFrom: true, reference: true, breakdown: true },
        orderBy: { generatedAt: 'asc' },
      }),
      // La primera semana liquidada de ESTE local (también anulada): lo de antes no se liquida ni se ajusta.
      start: (await tx.oxioPaySettlement.aggregate({ where: { tenantId: venueId }, _min: { periodFrom: true } }))._min.periodFrom,
    }));
    const active = rows.filter((r) => r.status !== 'VOID');
    const sameWeek = rows.filter((r) => r.periodFrom.getTime() === week.from.getTime());
    const current = sameWeek.find((r) => r.status !== 'VOID');
    if (current) return { kind: 'exists', id: current.id, reference: current.reference };
    const voided = sameWeek[sameWeek.length - 1];
    if (auto && voided) return { kind: 'voided', id: voided.id, reference: voided.reference };

    const stored = new Map(active.map((r) => [r.id, breakdownOf(r.breakdown)]));
    const ledger = ledgerOf([...stored.values()]);
    const platformBps = venue.platformCommissionBps;

    // La semana: cada noche con la cuenta del mapa del dinero (de una en una: sin agotar las conexiones).
    const computed = [];
    for (const night of nightsOf(week)) {
      computed.push({ ...night, concepts: await this.moneyMap.oxioPayOwed(venueId, night, { platformBps }) });
    }
    // El mapa de la semana entera: la comprobación (las noches suman lo mismo, céntimo a céntimo).
    const moneyMapCents = conceptsTotal(await this.moneyMap.oxioPayOwed(venueId, week, { platformBps }));
    const nightsCents = computed.reduce((sum, n) => sum + conceptsTotal(n.concepts), 0);
    if (nightsCents !== moneyMapCents) {
      this.logger.error(`Liquidación ${venueId} ${week.monday}: las noches suman ${nightsCents} y el mapa de la semana ${moneyMapCents}`);
    }
    const nights = periodNights(computed, ledger);

    // Semanas anteriores (desde la primera liquidada del local): ¿cambió algo con su fecha?
    // Si se generó a mano una semana anterior a otras sin liquidar, las de en medio entran aquí.
    const startFrom = start ?? week.from;
    const recomputed: RecomputedWeek[] = [];
    for (const w of [...lookbackWeeks].reverse()) {
      if (w.from < startFrom) continue;
      const own = active.find((r) => r.periodFrom.getTime() === w.from.getTime());
      const bps = own ? (stored.get(own.id)?.platformBps ?? platformBps) : platformBps;
      const owedNow = await this.moneyMap.oxioPayOwed(venueId, w, { platformBps: bps });
      const windows = nightsOf(w);
      if (sameConcepts(owedNow, ledgerTotal(windows.map((n) => n.day), ledger))) continue;
      const perNight = [];
      for (const n of windows) perNight.push({ day: n.day, concepts: await this.moneyMap.oxioPayOwed(venueId, n, { platformBps: bps }) });
      recomputed.push({ week: w, reference: own?.reference ?? null, nights: perNight });
    }
    const adjustments = adjustmentLines(recomputed, ledger);
    const totals = settlementTotals(nights, adjustments);
    return {
      venueId,
      businessId: venue.businessId,
      week,
      breakdown: {
        version: 1,
        party: { venueName: venue.name, venueSlug: venue.slug, businessName: venue.business?.name ?? null, businessTaxId: venue.business?.taxId ?? null },
        platformBps,
        nights: nights.map(({ day, from, to, concepts }) => ({ day, from, to, concepts })),
        adjustments,
      },
      nights,
      adjustments,
      totals,
      moneyMapCents,
      reference: settlementReference(week, venue.slug, sameWeek.length + 1),
      replacesId: sameWeek.length > 0 ? sameWeek[sameWeek.length - 1]!.id : null,
      horizonFrom,
      fingerprint: fingerprintOf(active),
    };
  }

  /** Guarda la liquidación con el local bloqueado, si nada cambió mientras se calculaba. */
  private async insert(plan: Plan, opts: { now: Date; auto: boolean; actor?: SettlementActor }): Promise<SettlementRow> {
    return this.prisma.acrossVenues(async (tx) => {
      await lockVenue(tx, plan.venueId);
      const active = await tx.oxioPaySettlement.findMany({
        where: { tenantId: plan.venueId, periodFrom: { gte: plan.horizonFrom }, status: { not: 'VOID' } },
        select: { id: true },
      });
      if (fingerprintOf(active) !== plan.fingerprint) throw new StaleLedgerError();
      return tx.oxioPaySettlement.create({
        data: {
          tenantId: plan.venueId,
          businessId: plan.businessId,
          periodFrom: plan.week.from,
          periodTo: plan.week.to,
          isoYear: plan.week.isoYear,
          isoWeek: plan.week.isoWeek,
          reference: plan.reference,
          periodCents: plan.totals.periodCents,
          adjustmentsCents: plan.totals.adjustmentsCents,
          totalCents: plan.totals.totalCents,
          moneyMapCents: plan.moneyMapCents,
          breakdown: plan.breakdown as unknown as Prisma.InputJsonValue,
          auto: opts.auto,
          generatedAt: opts.now,
          generatedById: opts.actor?.id ?? null,
          replacesId: plan.replacesId,
        },
      });
    });
  }

  // ─── Lecturas ──────────────────────────────────────────────────────────

  /** Las del local (el dueño): solo las suyas, con RLS de la base y el local explícito. */
  async listForOwner(tenantId: string, now: Date = new Date()): Promise<OwnerSettlementPage> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.oxioPaySettlement.findMany({ where: { tenantId }, orderBy: [{ periodFrom: 'desc' }, { generatedAt: 'desc' }], take: LIST_LIMIT }),
    );
    const items = rows.map((r) => listItemOf(r, now));
    return { items, payee: await this.payee(), pendingCents: items.reduce((sum, i) => sum + i.pendingCents, 0) };
  }

  async detailForOwner(tenantId: string, id: string, now: Date = new Date()): Promise<SettlementDetail> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.oxioPaySettlement.findFirst({ where: { id, tenantId }, include: { payments: { orderBy: { recordedAt: 'asc' } } } }),
    );
    if (!row) throw new NotFoundException(NOT_FOUND);
    // Quién apuntó cada pago es de OxioPay: al local no se le enseña.
    return detailOf(row, await this.payee(), new Map(), now);
  }

  /** El aviso del panel del dueño: las que llevan más de 7 días sin pagar entera. */
  async noticeForOwner(tenantId: string, now: Date = new Date()): Promise<OwnerSettlementNotice> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.oxioPaySettlement.findMany({
        where: { tenantId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
        orderBy: { generatedAt: 'asc' },
        take: LIST_LIMIT,
      }),
    );
    const overdue = rows
      .filter((r) => isOverdue(r, now))
      .map((r) => ({ id: r.id, reference: r.reference, pendingCents: settlementPendingCents(r), daysOpen: daysOpen(r.generatedAt, now) }));
    return { overdue, overdueCents: overdue.reduce((sum, o) => sum + o.pendingCents, 0) };
  }

  /** Todas (consola), con filtros, y lo pendiente de cobrar de todos los locales. */
  async listForSuperAdmin(query: SettlementListQuery, now: Date = new Date()): Promise<SuperAdminSettlementPage> {
    const where: Prisma.OxioPaySettlementWhereInput = {
      ...(query.venueId ? { tenantId: query.venueId } : {}),
      ...(query.businessId ? { businessId: query.businessId } : {}),
      ...(query.status === 'OPEN' ? { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } } : query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            periodFrom: {
              ...(query.from ? { gte: madridStartOfDay(query.from) } : {}),
              ...(query.to ? { lt: madridStartOfDay(nextDay(query.to)) } : {}),
            },
          }
        : {}),
      ...(query.q ? { reference: { contains: query.q.toUpperCase() } } : {}),
    };
    const { rows, open, payee } = await this.prisma.acrossVenues(async (tx) => ({
      rows: await tx.oxioPaySettlement.findMany({ where, orderBy: [{ periodFrom: 'desc' }, { generatedAt: 'desc' }], take: LIST_LIMIT }),
      open: await tx.oxioPaySettlement.findMany({
        where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
        select: { status: true, totalCents: true, paidCents: true, generatedAt: true },
      }),
      payee: await tx.oxioPayPayee.findUnique({ where: { id: 1 }, select: { id: true } }),
    }));
    const overdue = open.filter((r) => isOverdue(r, now));
    const pending = (list: typeof open) => list.reduce((sum, r) => sum + settlementPendingCents(r), 0);
    return {
      items: rows.map((r) => listItemOf(r, now)),
      totals: { pendingCents: pending(open), pendingCount: open.length, overdueCents: pending(overdue), overdueCount: overdue.length },
      payeeMissing: payee === null,
    };
  }

  async detailForSuperAdmin(id: string, now: Date = new Date()): Promise<SettlementDetail> {
    const { row, payee, emails } = await this.prisma.acrossVenues(async (tx) => {
      const found = await tx.oxioPaySettlement.findUnique({ where: { id }, include: { payments: { orderBy: { recordedAt: 'asc' } } } });
      const ids = found ? [...new Set(found.payments.map((p) => p.recordedById))] : [];
      const users = ids.length > 0 ? await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } }) : [];
      return { row: found, payee: await tx.oxioPayPayee.findUnique({ where: { id: 1 } }), emails: new Map(users.map((u) => [u.id, u.email])) };
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    return detailOf(row, payee ? payeeOf(payee) : null, emails, now);
  }

  /** Las abiertas con más de 7 días (para el aviso de Telegram), de la más antigua a la más nueva. */
  async overdueList(now: Date = new Date()): Promise<Array<{ reference: string; venueName: string; pendingCents: number; daysOpen: number }>> {
    const rows = await this.prisma.acrossVenues((tx) =>
      tx.oxioPaySettlement.findMany({ where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } }, orderBy: { generatedAt: 'asc' } }),
    );
    return rows
      .filter((r) => isOverdue(r, now))
      .map((r) => ({
        reference: r.reference,
        venueName: partyOf(r).venueName,
        pendingCents: settlementPendingCents(r),
        daysOpen: daysOpen(r.generatedAt, now),
      }));
  }

  // ─── Escrituras (el super-admin; el 2FA y el registro, en superadmin/settlements.service) ──

  /** Apunta una transferencia recibida. Con el importe pendiente, pagada; con menos (y motivo), pagada en parte. */
  async recordPayment(
    actor: SettlementActor,
    id: string,
    dto: Omit<RecordSettlementPaymentDto, 'totpCode'>,
    now: Date = new Date(),
  ): Promise<{ before: SettlementRow; after: SettlementRow; paymentId: string }> {
    if (dto.paidOn > madridDay(now)) throw new BadRequestException('La fecha del pago no puede ser futura');
    return this.prisma.acrossVenues(async (tx) => {
      const before = await lockSettlement(tx, id);
      if (before.status === 'VOID') throw new ConflictException('Esta liquidación está anulada: no se le apuntan pagos');
      if (before.status === 'PAID') throw new ConflictException('Esta liquidación ya está pagada entera');
      if (dto.paidOn < madridDay(before.periodFrom)) {
        throw new BadRequestException('La fecha del pago es anterior a la semana de la liquidación');
      }
      const problem = settlementPaymentProblem({ pendingCents: settlementPendingCents(before), amountCents: dto.amountCents, reason: dto.reason });
      if (problem) throw new BadRequestException(problem);
      const payment = await tx.oxioPaySettlementPayment.create({
        data: {
          tenantId: before.tenantId,
          settlementId: before.id,
          amountCents: dto.amountCents,
          paidOn: new Date(`${dto.paidOn}T00:00:00.000Z`),
          bankReference: dto.bankReference.trim(),
          reason: dto.reason?.trim() || null,
          recordedById: actor.id,
        },
      });
      const paidCents = before.paidCents + dto.amountCents;
      const status = settlementStatusAfterPayment(before.totalCents, paidCents);
      const after = await tx.oxioPaySettlement.update({
        where: { id },
        data: { paidCents, status, paidAt: status === 'PAID' ? now : null },
      });
      return { before, after, paymentId: payment.id };
    });
  }

  /** Anula una liquidación sin pagos (motivo). Lo suyo vuelve a estar sin liquidar: se puede regenerar. */
  async voidSettlement(actor: SettlementActor, id: string, reason: string, now: Date = new Date()): Promise<{ before: SettlementRow; after: SettlementRow }> {
    return this.prisma.acrossVenues(async (tx) => {
      const head = await tx.oxioPaySettlement.findUnique({ where: { id }, select: { tenantId: true } });
      if (!head) throw new NotFoundException(NOT_FOUND);
      // Como al generar: con el local bloqueado (no a la vez que se calcula otra).
      await lockVenue(tx, head.tenantId);
      const before = await lockSettlement(tx, id);
      if (before.status === 'VOID') throw new ConflictException('Esta liquidación ya está anulada');
      if (before.status !== 'ISSUED' || before.paidCents > 0) {
        throw new ConflictException('Solo se anula una liquidación sin pagos: esta ya tiene pagos apuntados');
      }
      const after = await tx.oxioPaySettlement.update({
        where: { id },
        data: { status: 'VOID', voidedAt: now, voidedById: actor.id, voidReason: reason.trim() },
      });
      return { before, after };
    });
  }

  /** La cuenta de OxioPay para las transferencias (null: aún no puesta). */
  async payee(): Promise<OxioPayPayee | null> {
    const row = await this.prisma.asSystem((tx) => tx.oxioPayPayee.findUnique({ where: { id: 1 } }));
    return row ? payeeOf(row) : null;
  }

  async setPayee(actor: SettlementActor, dto: Omit<SetOxioPayPayeeDto, 'totpCode'>): Promise<{ before: OxioPayPayee | null; after: OxioPayPayee }> {
    return this.prisma.acrossVenues(async (tx) => {
      const before = await tx.oxioPayPayee.findUnique({ where: { id: 1 } });
      const data = { name: dto.name.trim(), iban: dto.iban, holder: dto.holder.trim(), updatedById: actor.id };
      const after = await tx.oxioPayPayee.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
      return { before: before ? payeeOf(before) : null, after: payeeOf(after) };
    });
  }
}

/** Candado del local para generar y anular (de una en una por local, también entre réplicas). */
async function lockVenue(tx: TransactionalClient, venueId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(hashtext(${`oxiopay-settlement:${venueId}`}))`;
}

/** La liquidación bloqueada (FOR UPDATE) para cambiarla. */
async function lockSettlement(tx: TransactionalClient, id: string): Promise<SettlementRow> {
  const [locked] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM oxiopay_settlements WHERE id = ${id}::uuid FOR UPDATE`;
  if (!locked) throw new NotFoundException(NOT_FOUND);
  return tx.oxioPaySettlement.findUniqueOrThrow({ where: { id } });
}

function payeeOf(row: { name: string; iban: string; holder: string; updatedAt: Date }): OxioPayPayee {
  return { name: row.name, iban: row.iban, holder: row.holder, updatedAt: row.updatedAt.toISOString() };
}

/**
 * El local y su negocio de una liquidación para las listas. Un desglose que no
 * se puede leer no tumba la lista entera (la ficha sí lo dice).
 */
function partyOf(row: SettlementRow): SettlementParty {
  const parsed = StoredBreakdownSchema.safeParse(row.breakdown);
  if (parsed.success) return parsed.data.party;
  logger.error(`Liquidación ${row.id}: el desglose guardado no se puede leer`);
  return { venueName: row.reference, venueSlug: '', businessName: null, businessTaxId: null };
}

function listItemOf(row: SettlementRow, now: Date): SettlementListItem {
  const party = partyOf(row);
  return {
    id: row.id,
    reference: row.reference,
    venue: { id: row.tenantId, name: party.venueName, slug: party.venueSlug },
    business: row.businessId && party.businessName ? { id: row.businessId, name: party.businessName } : null,
    periodFrom: row.periodFrom.toISOString(),
    periodTo: row.periodTo.toISOString(),
    isoYear: row.isoYear,
    isoWeek: row.isoWeek,
    status: row.status,
    periodCents: row.periodCents,
    adjustmentsCents: row.adjustmentsCents,
    totalCents: row.totalCents,
    paidCents: row.paidCents,
    pendingCents: settlementPendingCents(row),
    generatedAt: row.generatedAt.toISOString(),
    auto: row.auto,
    overdue: isOverdue(row, now),
    daysOpen: isOpenSettlement(row.status) ? daysOpen(row.generatedAt, now) : 0,
  };
}

function detailOf(row: SettlementWithPayments, payee: OxioPayPayee | null, emails: ReadonlyMap<string, string>, now: Date): SettlementDetail {
  const b = breakdownOf(row.breakdown);
  const nights = b.nights.map((n) => ({ ...n, totalCents: conceptsTotal(n.concepts) }));
  return {
    ...listItemOf(row, now),
    party: b.party,
    nights,
    adjustments: b.adjustments,
    byConcept: settlementTotals(nights, b.adjustments).byConcept,
    moneyMapCents: row.moneyMapCents,
    payments: row.payments.map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      paidOn: p.paidOn.toISOString().slice(0, 10),
      bankReference: p.bankReference,
      reason: p.reason,
      recordedAt: p.recordedAt.toISOString(),
      recordedByEmail: emails.get(p.recordedById) ?? null,
    })),
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
    replacesId: row.replacesId,
    payee,
  };
}

/** Para pruebas y la consola: el lunes de una semana (AAAA-MM-DD) → la semana, o 400. */
export function weekFromMonday(monday: string): SettlementWeek {
  try {
    return weekStartingOn(monday);
  } catch (err) {
    throw new BadRequestException((err as Error).message);
  }
}
