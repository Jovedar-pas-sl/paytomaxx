import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import {
  conceptsTotal,
  formatMoney,
  settlementPendingCents,
  settlementStatusAfterPayment,
  type OwnerSettlementNotice,
  type OwnerSettlementPage,
  type OxioPayPayee,
  type RecordSettlementPaymentDto,
  type SetOxioPayPayeeDto,
  type SettlementAdjustment,
  type SettlementDetail,
  type SettlementListQuery,
  type SettlementNight,
  type SuperAdminSettlementPage,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { madridDay, madridStartOfDay, nextDay } from '../../common/time/madrid';
import { AuditService } from '../audit/audit.service';
import { MoneyMapService } from '../money-map/money-map.service';
import { paymentRefusal } from './settlement-payments';
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
  type RecomputedWeek,
  type SettlementTotals,
  type StoredBreakdown,
} from './settlement-rules';
import { detailOf, listItemOf, partyOf, payeeOf, type SettlementRow } from './settlement-views';
import {
  dueWeek,
  nextWeekAfter,
  nightsOf,
  previousWeeks,
  settlementReference,
  weekStartingOn,
  weeksBetween,
  type SettlementWeek,
} from './settlement-week';

/**
 * Semanas anteriores que se repasan al generar, por si algo se apuntó tarde
 * con su fecha (una devolución del banco, un aviso que llegó tarde, un
 * consumo anulado). Lo de más atrás no entra solo: lo avisa la comprobación
 * del lunes (reconcile).
 */
export const LOOKBACK_WEEKS = 12;
/** Reintentos si otra liquidación del local cambia mientras se calcula. */
const MAX_ATTEMPTS = 3;
const LIST_LIMIT = 200;
const NOT_FOUND = 'Liquidación no encontrada';

/** Quién la genera a mano, apunta un pago o cambia un ajuste (el super-admin). */
export interface SettlementActor {
  id: string;
  email: string;
}

/** Lo que se escribe en la misma transacción que el cambio (el registro): sin él, no hay cambio. */
export type InTx<T> = (tx: TransactionalClient, result: T) => Promise<void>;

export type GenerateOutcome =
  | { kind: 'created'; id: string; reference: string; totalCents: number; replacesId: string | null }
  | { kind: 'exists'; id: string; reference: string }
  /** El repaso no regenera una semana anulada por el super-admin (lo hace él a mano, o entra como ajuste). */
  | { kind: 'voided'; id: string; reference: string }
  | { kind: 'nothing'; totalCents: number };

/** Lo que la comprobación del lunes encuentra (se avisa por Telegram). */
export interface SettlementFinding {
  venueId: string;
  venueName: string;
  /**
   *  - outside_window: algo apuntado tarde más allá de las 12 semanas (no entra solo).
   *  - closed_pending: local dado de baja con liquidaciones sin pagar.
   *  - closed_unsettled: local dado de baja con algo sin liquidar.
   *  - check_failed: no se pudo comprobar.
   */
  kind: 'outside_window' | 'closed_pending' | 'closed_unsettled' | 'check_failed';
  cents: number;
  detail?: string;
}

export interface RunResult {
  week: SettlementWeek | null;
  created: string[];
  failed: string[];
  findings: SettlementFinding[];
  /** La semana que tocaba es anterior a la de inicio: no se liquida. */
  beforeStart?: boolean;
}

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

/** Otra liquidación del local cambió mientras se calculaba: se vuelve a calcular. */
class StaleLedgerError extends Error {}

/** Las noches no suman lo que da el mapa de la semana (ni al repetir): no se emite. */
export class SettlementMapMismatchError extends ConflictException {
  constructor(nightsCents: number, weekCents: number) {
    super({
      message: `Las noches de la semana suman ${formatMoney(nightsCents)} y el mapa del dinero de la semana da ${formatMoney(weekCents)}: no se emite. Vuelve a probar en un momento.`,
      code: 'SETTLEMENT_MAP_MISMATCH',
    });
  }
}

const fingerprintOf = (rows: ReadonlyArray<{ id: string }>): string =>
  rows
    .map((r) => r.id)
    .sort()
    .join(',');

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * «Liquidación OxioPay»: lo que cada local debe a OxioPay por semana (lunes
 * 08:00 → lunes 08:00 de Madrid), desde la semana de inicio (ajuste de la
 * plataforma). Las cifras salen del mapa del dinero (MoneyMapService.oxioPayOwed,
 * las mismas filas y cuentas): el total de una semana cuadra con lo que el mapa
 * da para esa ventana. Al generarla se congela; lo apuntado tarde con fecha de
 * una semana ya liquidada va a la siguiente como «ajustes de semanas
 * anteriores» (settlement-rules.ts). Las escrituras van con el local bloqueado
 * (candado de transacción) y con su registro en la misma transacción.
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

  // ─── Semana de inicio ──────────────────────────────────────────────────

  /** La semana de inicio (null: aún no fijada). */
  async startWeek(): Promise<SettlementWeek | null> {
    const row = await this.prisma.asSystem((tx) => tx.oxioPaySettlementSettings.findUnique({ where: { id: 1 } }));
    return row ? weekStartingOn(dayOf(row.startWeek)) : null;
  }

  /**
   * Vacía: el próximo lunes (la primera semana completa tras desplegar).
   * Nunca se liquida nada anterior. Dos réplicas a la vez: la primera fija.
   */
  async ensureStartWeek(now: Date): Promise<SettlementWeek> {
    const current = await this.startWeek();
    if (current) return current;
    const next = nextWeekAfter(now);
    await this.prisma.asSystem(async (tx) => {
      const inserted = await tx.$executeRaw`
        INSERT INTO oxiopay_settlement_settings (id, "startWeek") VALUES (1, ${next.monday}::date)
        ON CONFLICT (id) DO NOTHING`;
      if (inserted > 0) {
        await this.audit.logInTx(tx, {
          action: 'superadmin.settlement.start_week_set',
          targetType: 'OxioPaySettlementSettings',
          targetId: '1',
          payload: { auto: true, startWeek: next.monday },
        });
      }
    });
    this.logger.log(`Liquidaciones OxioPay: semana de inicio ${next.monday} (la primera completa tras desplegar)`);
    return (await this.startWeek()) ?? next;
  }

  /** Cambiarla (el super-admin, con 2FA y motivo en la consola). */
  async setStartWeek(
    actor: SettlementActor,
    monday: string,
    onWrite?: InTx<{ before: string | null; after: string }>,
  ): Promise<{ before: string | null; after: string }> {
    const week = weekFromMonday(monday);
    return this.prisma.acrossVenues(async (tx) => {
      const prev = await tx.oxioPaySettlementSettings.findUnique({ where: { id: 1 } });
      const data = { startWeek: new Date(`${week.monday}T00:00:00.000Z`), updatedById: actor.id };
      await tx.oxioPaySettlementSettings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
      const result = { before: prev ? dayOf(prev.startWeek) : null, after: week.monday };
      await onWrite?.(tx, result);
      return result;
    });
  }

  // ─── Generación ────────────────────────────────────────────────────────

  /**
   * El repaso del lunes: la semana terminada de cada local (si es lunes antes
   * de las 10:00, o la semana es anterior a la de inicio, nada) y la
   * comprobación acumulada. Cada local por separado: un fallo no corta los demás.
   */
  async runDue(now: Date = new Date()): Promise<RunResult> {
    const week = dueWeek(now);
    if (!week) return { week: null, created: [], failed: [], findings: [] };
    const start = await this.ensureStartWeek(now);
    if (week.from < start.from) return { week, created: [], failed: [], findings: [], beforeStart: true };
    const venues = await this.prisma.acrossVenues((tx) =>
      tx.venue.findMany({
        where: { createdAt: { lt: week.to }, OR: [{ deletedAt: null }, { deletedAt: { gte: week.from } }] },
        select: { id: true, name: true },
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
        failed.push(`${venue.name}: ${(err as Error).message}`);
        this.logger.error(`Liquidación de ${venue.id} (${week.monday}): ${(err as Error).message}`);
      }
    }
    if (created.length > 0 && !(await this.payee())) {
      this.logger.warn('Liquidaciones OxioPay emitidas sin la cuenta de OxioPay (Super admin → Liquidaciones → Cuenta de OxioPay)');
    }
    const findings = await this.reconcile(week, start, venues);
    return { week, created, failed, findings };
  }

  /**
   * La liquidación de un local y una semana ya terminada (desde la semana de
   * inicio). Si ya hay una activa, esa (no se duplica); si no hay nada que
   * liquidar, no se crea.
   */
  async generate(
    venueId: string,
    week: SettlementWeek,
    opts: { now: Date; auto: boolean; actor?: SettlementActor; onWrite?: InTx<SettlementRow> },
  ): Promise<GenerateOutcome> {
    const start = await this.generationStart(week, opts.now);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const plan = await this.plan(venueId, week, opts.auto, start);
      if ('kind' in plan) return plan;
      if (plan.totals.totalCents <= 0) return { kind: 'nothing', totalCents: plan.totals.totalCents };
      try {
        const row = await this.insert(plan, opts);
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

  /** La semana de inicio, si la semana se puede generar (terminada y no anterior); si no, 400. Antes del 2FA. */
  async generationStart(week: SettlementWeek, now: Date): Promise<SettlementWeek> {
    if (week.to.getTime() > now.getTime()) throw new BadRequestException('Esa semana aún no ha terminado (acaba el lunes a las 08:00)');
    const start = await this.ensureStartWeek(now);
    if (week.from < start.from) {
      throw new BadRequestException(`Esa semana es anterior a la semana de inicio de las liquidaciones (lunes ${start.monday}): no se liquida`);
    }
    return start;
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
    start: SettlementWeek,
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
    const rows = await this.prisma.acrossVenues((tx) =>
      tx.oxioPaySettlement.findMany({
        where: { tenantId: venueId, periodFrom: { gte: horizonFrom } },
        select: { id: true, status: true, periodFrom: true, reference: true, breakdown: true },
        orderBy: { generatedAt: 'asc' },
      }),
    );
    const active = rows.filter((r) => r.status !== 'VOID');
    const sameWeek = rows.filter((r) => r.periodFrom.getTime() === week.from.getTime());
    const current = sameWeek.find((r) => r.status !== 'VOID');
    if (current) return { kind: 'exists', id: current.id, reference: current.reference };
    const voided = sameWeek[sameWeek.length - 1];
    if (auto && voided) return { kind: 'voided', id: voided.id, reference: voided.reference };

    const stored = new Map(active.map((r) => [r.id, breakdownOf(r.breakdown)]));
    const ledger = ledgerOf([...stored.values()]);
    const platformBps = venue.platformCommissionBps;
    const { computed, moneyMapCents } = await this.weekOwed(venueId, week, platformBps);
    const nights = periodNights(computed, ledger);

    // Semanas anteriores (desde la de inicio): ¿cambió algo con su fecha? Una ya
    // liquidada se recalcula con su % de plataforma congelado (los consumos de
    // antes no lo llevan fijado); las demás, con el de ahora.
    const recomputed: RecomputedWeek[] = [];
    for (const w of [...lookbackWeeks].reverse()) {
      if (w.from < start.from) continue;
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

  /**
   * Las 7 noches con la cuenta del mapa del dinero y el mapa de la semana
   * entera, que tienen que sumar lo mismo céntimo a céntimo. Si no (algo se
   * apuntó mientras se calculaba), se repite una vez; si sigue sin cuadrar,
   * no se emite (SettlementMapMismatchError: el repaso lo avisa).
   */
  private async weekOwed(venueId: string, week: SettlementWeek, platformBps: number) {
    for (let attempt = 1; ; attempt += 1) {
      const computed = [];
      // De una en una: sin agotar las conexiones.
      for (const night of nightsOf(week)) {
        computed.push({ ...night, concepts: await this.moneyMap.oxioPayOwed(venueId, night, { platformBps }) });
      }
      const moneyMapCents = conceptsTotal(await this.moneyMap.oxioPayOwed(venueId, week, { platformBps }));
      const nightsCents = computed.reduce((sum, n) => sum + conceptsTotal(n.concepts), 0);
      if (nightsCents === moneyMapCents) return { computed, moneyMapCents };
      this.logger.error(`Liquidación ${venueId} ${week.monday} (vez ${attempt}): las noches suman ${nightsCents} y el mapa de la semana ${moneyMapCents}`);
      if (attempt >= 2) throw new SettlementMapMismatchError(nightsCents, moneyMapCents);
    }
  }

  /** Guarda la liquidación con el local bloqueado, si nada cambió mientras se calculaba; el registro, en la misma transacción. */
  private async insert(plan: Plan, opts: { now: Date; auto: boolean; actor?: SettlementActor; onWrite?: InTx<SettlementRow> }): Promise<SettlementRow> {
    return this.prisma.acrossVenues(async (tx) => {
      await lockVenue(tx, plan.venueId);
      const active = await tx.oxioPaySettlement.findMany({
        where: { tenantId: plan.venueId, periodFrom: { gte: plan.horizonFrom }, status: { not: 'VOID' } },
        select: { id: true },
      });
      if (fingerprintOf(active) !== plan.fingerprint) throw new StaleLedgerError();
      const row = await tx.oxioPaySettlement.create({
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
      if (opts.auto) {
        // La del repaso, al registro aquí (la del super-admin la apunta la consola, con quién, IP y motivo).
        await this.audit.logInTx(tx, {
          action: 'superadmin.settlement.generated',
          tenantId: plan.venueId,
          targetType: 'OxioPaySettlement',
          targetId: row.id,
          payload: {
            auto: true,
            reference: row.reference,
            week: plan.week.monday,
            periodCents: row.periodCents,
            adjustmentsCents: row.adjustmentsCents,
            totalCents: row.totalCents,
          },
        });
      }
      await opts.onWrite?.(tx, row);
      return row;
    });
  }

  // ─── Comprobación acumulada (D4) ───────────────────────────────────────

  /**
   * Desde la semana de inicio, lo que da el mapa contra lo ya liquidado:
   *  - locales activos: lo de antes de la ventana de 12 semanas (algo apuntado
   *    muy tarde: no entra solo en ninguna liquidación);
   *  - locales dados de baja (después de la de inicio y antes de esta semana):
   *    lo pendiente de pagar y lo que quede sin liquidar (ya no se generan).
   */
  async reconcile(week: SettlementWeek, start: SettlementWeek, active: ReadonlyArray<{ id: string; name: string }>): Promise<SettlementFinding[]> {
    const findings: SettlementFinding[] = [];
    const horizonFrom = previousWeeks(week, LOOKBACK_WEEKS)[LOOKBACK_WEEKS - 1]!.from;
    const check = async (venue: { id: string; name: string }, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        findings.push({ venueId: venue.id, venueName: venue.name, kind: 'check_failed', cents: 0, detail: (err as Error).message });
      }
    };
    if (horizonFrom > start.from) {
      for (const venue of active) {
        await check(venue, async () => {
          const cents = await this.unsettledBetween(venue.id, start, horizonFrom);
          if (cents !== 0) findings.push({ venueId: venue.id, venueName: venue.name, kind: 'outside_window', cents });
        });
      }
    }
    const closed = await this.prisma.acrossVenues((tx) =>
      tx.venue.findMany({ where: { deletedAt: { not: null, gte: start.from, lt: week.from } }, select: { id: true, name: true } }),
    );
    for (const venue of closed) {
      await check(venue, async () => {
        const open = await this.prisma.acrossVenues((tx) =>
          tx.oxioPaySettlement.findMany({
            where: { tenantId: venue.id, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
            select: { status: true, totalCents: true, paidCents: true },
          }),
        );
        const pending = open.reduce((sum, s) => sum + settlementPendingCents(s), 0);
        if (pending > 0) findings.push({ venueId: venue.id, venueName: venue.name, kind: 'closed_pending', cents: pending });
        const unsettled = await this.unsettledBetween(venue.id, start, week.to);
        if (unsettled !== 0) findings.push({ venueId: venue.id, venueName: venue.name, kind: 'closed_unsettled', cents: unsettled });
      });
    }
    return findings;
  }

  /** Lo que da el mapa en [inicio, antes) menos lo ya liquidado de esas noches (en tramos de 12 semanas). */
  private async unsettledBetween(venueId: string, start: SettlementWeek, before: Date): Promise<number> {
    const weeks = weeksBetween(start, before);
    if (weeks.length === 0) return 0;
    let owed = 0;
    for (let i = 0; i < weeks.length; i += LOOKBACK_WEEKS) {
      const chunk = weeks.slice(i, i + LOOKBACK_WEEKS);
      owed += conceptsTotal(await this.moneyMap.oxioPayOwed(venueId, { from: chunk[0]!.from, to: chunk[chunk.length - 1]!.to }));
    }
    const rows = await this.prisma.acrossVenues((tx) =>
      tx.oxioPaySettlement.findMany({ where: { tenantId: venueId, status: { not: 'VOID' } }, select: { breakdown: true } }),
    );
    const ledger = ledgerOf(rows.map((r) => breakdownOf(r.breakdown)));
    const firstDay = weeks[0]!.monday;
    const endDay = madridDay(weeks[weeks.length - 1]!.to);
    let settled = 0;
    for (const [day, amounts] of ledger) {
      if (day >= firstDay && day < endDay) settled += conceptsTotal(amounts);
    }
    return owed - settled;
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
    // Quién apuntó cada pago y los motivos internos son de OxioPay: al local no se le enseñan.
    return detailOf(row, await this.payee(), new Map(), now, 'owner');
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

  /** Todas (consola), con filtros, lo pendiente de cobrar de todos los locales y la semana de inicio. */
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
    const { rows, open, payee, settings } = await this.prisma.acrossVenues(async (tx) => ({
      rows: await tx.oxioPaySettlement.findMany({ where, orderBy: [{ periodFrom: 'desc' }, { generatedAt: 'desc' }], take: LIST_LIMIT }),
      open: await tx.oxioPaySettlement.findMany({
        where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
        select: { status: true, totalCents: true, paidCents: true, generatedAt: true },
      }),
      payee: await tx.oxioPayPayee.findUnique({ where: { id: 1 }, select: { id: true } }),
      settings: await tx.oxioPaySettlementSettings.findUnique({ where: { id: 1 } }),
    }));
    const overdue = open.filter((r) => isOverdue(r, now));
    const pending = (list: typeof open) => list.reduce((sum, r) => sum + settlementPendingCents(r), 0);
    return {
      items: rows.map((r) => listItemOf(r, now)),
      totals: { pendingCents: pending(open), pendingCount: open.length, overdueCents: pending(overdue), overdueCount: overdue.length },
      payeeMissing: payee === null,
      startWeek: settings ? dayOf(settings.startWeek) : null,
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
    return detailOf(row, payee ? payeeOf(payee) : null, emails, now, 'superadmin');
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

  // ─── Escrituras (el super-admin; el 2FA en superadmin/settlements.service) ──

  /** Lo de apuntar un pago que se puede comprobar ANTES del 2FA (no se gasta el código en algo que no va a valer). */
  async paymentPrecheck(id: string, dto: Omit<RecordSettlementPaymentDto, 'totpCode'>, now: Date = new Date()): Promise<void> {
    const found = await this.prisma.acrossVenues((tx) =>
      tx.oxioPaySettlement.findUnique({ where: { id }, include: { payments: { select: { bankReference: true, amountCents: true, paidOn: true } } } }),
    );
    if (!found) throw new NotFoundException(NOT_FOUND);
    const refusal = paymentRefusal({ settlement: found, existing: found.payments, dto, today: madridDay(now) });
    if (refusal) throw refusal;
  }

  /**
   * Apunta una transferencia recibida: con el importe pendiente, pagada; con
   * menos (y motivo), pagada en parte. Con la liquidación bloqueada, las mismas
   * comprobaciones otra vez y el registro (onWrite) en la misma transacción.
   */
  async recordPayment(
    actor: SettlementActor,
    id: string,
    dto: Omit<RecordSettlementPaymentDto, 'totpCode'>,
    now: Date = new Date(),
    onWrite?: InTx<{ before: SettlementRow; after: SettlementRow; paymentId: string }>,
  ): Promise<{ before: SettlementRow; after: SettlementRow; paymentId: string }> {
    return this.prisma.acrossVenues(async (tx) => {
      const before = await lockSettlement(tx, id);
      const existing = await tx.oxioPaySettlementPayment.findMany({
        where: { settlementId: id },
        select: { bankReference: true, amountCents: true, paidOn: true },
      });
      const refusal = paymentRefusal({ settlement: before, existing, dto, today: madridDay(now) });
      if (refusal) throw refusal;
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
      const result = { before, after, paymentId: payment.id };
      await onWrite?.(tx, result);
      return result;
    });
  }

  /** ¿Se puede anular? (antes del 2FA). */
  async voidPrecheck(id: string): Promise<void> {
    const found = await this.prisma.acrossVenues((tx) => tx.oxioPaySettlement.findUnique({ where: { id }, select: { status: true, paidCents: true } }));
    if (!found) throw new NotFoundException(NOT_FOUND);
    const refusal = voidRefusal(found);
    if (refusal) throw refusal;
  }

  /** Anula una liquidación sin pagos (motivo). Lo suyo vuelve a estar sin liquidar: se puede regenerar. */
  async voidSettlement(
    actor: SettlementActor,
    id: string,
    reason: string,
    now: Date = new Date(),
    onWrite?: InTx<{ before: SettlementRow; after: SettlementRow }>,
  ): Promise<{ before: SettlementRow; after: SettlementRow }> {
    return this.prisma.acrossVenues(async (tx) => {
      const head = await tx.oxioPaySettlement.findUnique({ where: { id }, select: { tenantId: true } });
      if (!head) throw new NotFoundException(NOT_FOUND);
      // Como al generar: con el local bloqueado (no a la vez que se calcula otra).
      await lockVenue(tx, head.tenantId);
      const before = await lockSettlement(tx, id);
      const refusal = voidRefusal(before);
      if (refusal) throw refusal;
      const after = await tx.oxioPaySettlement.update({
        where: { id },
        data: { status: 'VOID', voidedAt: now, voidedById: actor.id, voidReason: reason.trim() },
      });
      const result = { before, after };
      await onWrite?.(tx, result);
      return result;
    });
  }

  /** La cuenta de OxioPay para las transferencias (null: aún no puesta). */
  async payee(): Promise<OxioPayPayee | null> {
    const row = await this.prisma.asSystem((tx) => tx.oxioPayPayee.findUnique({ where: { id: 1 } }));
    return row ? payeeOf(row) : null;
  }

  async setPayee(
    actor: SettlementActor,
    dto: Omit<SetOxioPayPayeeDto, 'totpCode'>,
    onWrite?: InTx<{ before: OxioPayPayee | null; after: OxioPayPayee }>,
  ): Promise<{ before: OxioPayPayee | null; after: OxioPayPayee }> {
    return this.prisma.acrossVenues(async (tx) => {
      const prev = await tx.oxioPayPayee.findUnique({ where: { id: 1 } });
      const data = { name: dto.name.trim(), iban: dto.iban, holder: dto.holder.trim(), updatedById: actor.id };
      const next = await tx.oxioPayPayee.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
      const result = { before: prev ? payeeOf(prev) : null, after: payeeOf(next) };
      await onWrite?.(tx, result);
      return result;
    });
  }
}

/** Solo se anula sin pagos. */
function voidRefusal(s: { status: string; paidCents: number }): ConflictException | null {
  if (s.status === 'VOID') return new ConflictException('Esta liquidación ya está anulada');
  if (s.status !== 'ISSUED' || s.paidCents > 0) return new ConflictException('Solo se anula una liquidación sin pagos: esta ya tiene pagos apuntados');
  return null;
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

/** El lunes de una semana (AAAA-MM-DD) → la semana, o 400. */
export function weekFromMonday(monday: string): SettlementWeek {
  try {
    return weekStartingOn(monday);
  } catch (err) {
    throw new BadRequestException((err as Error).message);
  }
}
