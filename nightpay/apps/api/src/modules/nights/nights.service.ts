import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  evaluateCash,
  nightCloseRefusal,
  withCashInput,
  type NightCloseCheck,
  type NightCloseStep,
  type NightCloseStepKey,
} from '@nightpay/contracts';
import { Prisma } from '@nightpay/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { lastNightCutoff } from '../../common/time/madrid';
import { AuditService } from '../audit/audit.service';
import { totpForbidden } from '../auth/totp-code';
import { TotpService } from '../auth/totp.service';
import { summarize } from '../reports/export-csv';
import type {
  AdjustmentRows,
  CobroRow,
  ConsumoRow,
  DevolucionRow,
  LiquidacionRow,
  PagoSaldoRow,
  RecargaEfectivoRow,
} from '../reports/export-rows';
import type { TimeWindow } from '../reports/report-period';
import { afterPayoutDebt, paymentAt } from '../reports/reporting-sql';
import { ReportsService } from '../reports/reports.service';
import { fichasCounts, type FichasCounts } from '../wallets/fichas-counts';
import { MoneyMapService } from '../money-map/money-map.service';
import { CloseCheckService } from './close-check.service';
import { settleWritesBefore } from './night-cutoff';
import {
  autoCloseAt,
  buildAdjustments,
  buildNightCaja,
  buildNightZ,
  cashFromRows,
  unresolvedPaymentsWhere,
  zStart,
  type NightCaja,
  type NightZ,
} from './night-rules';

/** Cobro que impide cerrar la noche: atascado con el banco o datáfono sin confirmar. */
export interface PendingPayment {
  id: string;
  status: string;
  amountCents: number;
  createdAt: Date;
  captureMethod: string | null;
}

export interface NightView {
  id: string;
  openedAt: string;
  closedAt: string | null;
  autoClosed: boolean;
  pendingAtClose: number;
  closeNote: string | null;
  /** Fondo de caja con el que empezó (null = no se apuntó). */
  openingFloatCents: number | null;
  /** Congelado si la noche está cerrada (con su caja); en vivo si está abierta. */
  z: NightZ;
  /** Solo con la noche abierta. */
  pending: PendingPayment[];
}

export interface NightListItem {
  id: string;
  openedAt: string;
  closedAt: string | null;
  autoClosed: boolean;
  pendingAtClose: number;
  count: number | null;
  chargedCents: number | null;
  netCents: number | null;
  /** Diferencia de caja al cerrar (contado − esperado); null si no se contó. */
  cashDiffCents: number | null;
}

/** Lo que ve la chica de su noche: la abierta, o la última si acaba de cerrarse. */
export interface MyNight {
  from: string;
  /** Hora de cierre si es la última noche ya cerrada; null si sigue abierta o no hay. */
  to: string | null;
  nightOpen: boolean;
  count: number;
  chargedCents: number;
  commissionCents: number;
  tipsCents: number;
  reversedCents: number;
  netCents: number;
  /** De esta noche, lo que aún no se le ha pagado (comisión + propinas − devoluciones). */
  unpaidCents: number;
  /** Lo ganado fuera de esta noche (otras noches) y aún sin pagar. Sin restar deudas. */
  otherUnpaidCents: number;
}

type NightRow = {
  id: string;
  tenantId: string;
  openedAt: Date;
  closedAt: Date | null;
  autoClosed: boolean;
  pendingAtClose: number;
  closeNote: string | null;
  openingFloatCents: number | null;
  zReport: Prisma.JsonValue | null;
};

/** Lo que manda quien cierra: avisos confirmados, nota y arqueo de caja (CloseNightDto). */
export interface CloseNightOptions {
  acknowledged?: ReadonlyArray<NightCloseStepKey>;
  note?: string;
  cashCountedCents?: number;
  openingFloatCents?: number;
  cashNote?: string;
  /** 2FA del dueño, para cambiar el fondo que se apuntó al abrir. */
  totpCode?: string;
}

/** Las filas del Z de una noche, leídas una vez: el Z, su caja y los pasos salen de ellas. */
interface ZRows {
  cobros: CobroRow[];
  devoluciones: DevolucionRow[];
  liquidaciones: LiquidacionRow[];
  consumos: ConsumoRow[];
  pagosSaldo: PagoSaldoRow[];
  recargasEfectivo: RecargaEfectivoRow[];
  late: AdjustmentRows;
  fichas: FichasCounts;
}

/** Caja que se guarda en venue_nights al cerrar (además de en el Z). */
interface CashColumns {
  openingFloatCents: number | null;
  cashCountedCents: number | null;
  cashExpectedCents: number;
  cashDiffCents: number | null;
  cashNote: string | null;
}

const AUTO_CLOSE_NOTE = 'Cierre automático a las 08:00';

/** Tras cerrar, la chica sigue viendo esa noche durante este tiempo. */
const LAST_NIGHT_VISIBLE_MS = 16 * 60 * 60 * 1000;

/** Cuántos cobros pendientes se listan (el número total va aparte). */
const PENDING_LIST_LIMIT = 100;

const CLOSE_REFUSAL_HINT: Record<'blocked' | 'needs-ack', string> = {
  blocked: 'No se puede cerrar todavía.',
  'needs-ack': 'Confirma antes estos avisos:',
};

interface PendingResult {
  items: PendingPayment[];
  count: number;
}

/**
 * Noche del local (Fase 1D): se abre, se cierra en pasos (cobros, datáfonos,
 * saldo, arqueo de caja, chicas, incidencias) y se congela el informe Z con
 * su caja. Un paso que bloquea no deja cerrar y los avisos se confirman
 * (close-check-rules + nightCloseRefusal de @nightpay/contracts). Las cuentas son
 * las mismas que las del informe de la gestoría (ReportsService + summarize).
 * Lo que se apunta después de un Z con fecha de su noche (un cobro que el
 * banco confirma tarde, una devolución con fecha atrás) va como ajuste en el
 * Z siguiente: los Z congelados no cambian y nada se queda fuera.
 */
@Injectable()
export class NightsService {
  private readonly logger = new Logger(NightsService.name);
  private readonly prisma: PrismaService;
  private readonly reports: ReportsService;
  private readonly audit: AuditService;
  private readonly checks: CloseCheckService;
  private readonly totp: Pick<TotpService, 'assertForUser' | 'isEnabled'> | null;
  private readonly moneyMap: Pick<MoneyMapService, 'compute'> | null;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(ReportsService) reports: ReportsService,
    @Inject(AuditService) audit: AuditService,
    @Inject(CloseCheckService) checks: CloseCheckService,
    @Optional() @Inject(TotpService) totp?: TotpService,
    @Optional() @Inject(MoneyMapService) moneyMap?: MoneyMapService,
  ) {
    this.prisma = prisma;
    this.reports = reports;
    this.audit = audit;
    this.checks = checks;
    this.totp = totp ?? null;
    this.moneyMap = moneyMap ?? null;
  }

  async current(tenantId: string): Promise<NightView | null> {
    await this.safeAutoClose(tenantId);
    const night = await this.openNight(tenantId);
    return night ? this.view(night) : null;
  }

  async open(tenantId: string, userId: string, openingFloatCents?: number): Promise<NightView> {
    await this.safeAutoClose(tenantId);
    let night: NightRow;
    try {
      night = await this.prisma.venueNight.create({
        data: { tenantId, openedBy: userId, openingFloatCents: openingFloatCents ?? null },
      });
    } catch (err) {
      // Índice único parcial: una sola noche abierta por local.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Ya hay una noche abierta en este local');
      }
      throw err;
    }
    await this.audit.log({
      action: 'night.opened',
      tenantId,
      actorId: userId,
      targetType: 'VenueNight',
      targetId: night.id,
      payload: { openedAt: night.openedAt.toISOString(), openingFloatCents: night.openingFloatCents },
    });
    return this.view(night);
  }

  /** Los pasos para cerrar la noche abierta (qué falta, la caja y lo de cada chica). */
  async closeCheck(tenantId: string): Promise<NightCloseCheck> {
    await this.safeAutoClose(tenantId);
    const night = await this.openNight(tenantId);
    if (!night) throw new NotFoundException('No hay ninguna noche abierta');
    const now = new Date();
    const start = await this.zBounds(tenantId, night.openedAt);
    return this.checks.check(tenantId, night, { from: start.from, to: now }, now);
  }

  /**
   * Cierra la noche si ningún paso bloquea y los avisos están confirmados:
   * congela el Z con su caja (lo contado y la diferencia). Los pasos se
   * recalculan aquí, al cerrar: lo que vio el panel puede ser de hace un rato.
   */
  async close(
    tenantId: string,
    actor: { userId: string; role: string },
    nightId: string,
    opts: CloseNightOptions = {},
  ): Promise<NightView> {
    // Pasadas las 08:00 la noche ya está vencida: se cierra sola (con el Z
    // hasta las 08:00) en vez de meter en ella los cobros de la mañana.
    await this.safeAutoClose(tenantId);
    const night = await this.prisma.venueNight.findFirst({ where: { id: nightId, tenantId } });
    if (!night) throw new NotFoundException('Noche no encontrada');
    if (night.closedAt) {
      throw new ConflictException(
        night.autoClosed ? 'Esta noche ya se cerró sola a las 08:00' : 'Esta noche ya está cerrada',
      );
    }

    // El corte: el Z cuenta lo apuntado antes de este instante y el siguiente
    // empieza aquí. Antes de leer, que termine lo que empezó antes del corte
    // (un cobro confirmándose ahora mismo no se queda fuera de los dos Z).
    const now = new Date();
    await this.settleBeforeCutoff(night.id, now);
    const start = await this.zBounds(tenantId, night.openedAt);
    const window = { from: start.from, to: now };
    // Las filas del Z, una vez: la caja (y su paso) sale de ellas, así el Z
    // congelado y su caja cuentan lo mismo aunque algo se apunte mientras.
    const rows = await this.zRows(tenantId, window, now, start.since);
    const check = await this.checks.check(tenantId, night, window, now, cashFromRows(night.openingFloatCents, rows));
    const input = {
      openingFloatCents: opts.openingFloatCents,
      countedCents: opts.cashCountedCents,
      floatChangeApproved: await this.floatChangeApproved(actor, night.openingFloatCents, opts),
    };
    assertCanClose(withCashInput(check.steps, check.cash, input), opts.acknowledged ?? [], opts.note);

    const caja = buildNightCaja(check.cash, evaluateCash(check.cash, input), opts.cashNote, now);
    const pending = await this.pending(tenantId, window);
    const z = await this.withMoneyMap(tenantId, night.id, window, now, this.zFrom(window, rows, pending.count, now, start.since, caja));
    const closed = await this.markClosed(night.id, tenantId, {
      closedAt: now,
      closedBy: actor.userId,
      autoClosed: false,
      pendingAtClose: pending.count,
      closeNote: opts.note?.trim() || null,
      z,
      cash: cashColumns(caja),
    });
    if (!closed) throw new ConflictException('Esta noche ya está cerrada (puede que se cerrara sola a las 08:00)');

    await this.audit.log({
      action: 'night.closed',
      tenantId,
      actorId: actor.userId,
      targetType: 'VenueNight',
      targetId: night.id,
      payload: {
        pendingAtClose: pending.count,
        netCents: z.summary.netCents,
        acknowledged: [...(opts.acknowledged ?? [])],
        cash: {
          openingFloatCents: caja.openingFloatCents,
          recordedFloatCents: caja.recordedFloatCents ?? null,
          expectedCents: caja.expectedCents,
          countedCents: caja.countedCents,
          diffCents: caja.diffCents,
        },
      },
    });
    return this.get(tenantId, night.id);
  }

  async list(tenantId: string, limit = 30): Promise<NightListItem[]> {
    await this.safeAutoClose(tenantId);
    const nights = await this.prisma.venueNight.findMany({
      where: { tenantId },
      orderBy: { openedAt: 'desc' },
      take: limit,
    });
    return nights.map((n) => {
      const z = n.zReport as unknown as NightZ | null;
      return {
        id: n.id,
        openedAt: n.openedAt.toISOString(),
        closedAt: n.closedAt?.toISOString() ?? null,
        autoClosed: n.autoClosed,
        pendingAtClose: n.pendingAtClose,
        count: z?.summary.count ?? null,
        chargedCents: z?.summary.chargedCents ?? null,
        netCents: z?.summary.netCents ?? null,
        cashDiffCents: n.cashDiffCents,
      };
    });
  }

  async get(tenantId: string, nightId: string): Promise<NightView> {
    const night = await this.prisma.venueNight.findFirst({ where: { id: nightId, tenantId } });
    if (!night) throw new NotFoundException('Noche no encontrada');
    return this.view(night);
  }

  /**
   * Noche de una chica: la abierta; si ya se cerró hace poco, esa noche
   * (hasta su cierre); si no hay, desde las últimas 08:00.
   */
  async mine(tenantId: string, operatorId: string): Promise<MyNight> {
    await this.safeAutoClose(tenantId);
    const now = new Date();
    const open = await this.openNight(tenantId);
    const last = open
      ? null
      : await this.prisma.venueNight.findFirst({
          where: { tenantId, closedAt: { gte: new Date(now.getTime() - LAST_NIGHT_VISIBLE_MS) } },
          orderBy: { closedAt: 'desc' },
        });
    const night = open ?? last;
    // Para la chica, desde que se abrió la noche (el Z del local cuenta desde el cierre anterior).
    const from = night?.openedAt ?? lastNightCutoff(now);
    const to = last?.closedAt ?? now;
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<
      Array<{ count: number; chargedCents: number; commissionCents: number; tipsCents: number; reversedCents: number }>
    >`
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM(x.charged), 0)::int AS "chargedCents",
             COALESCE(SUM(x.commission), 0)::int AS "commissionCents",
             COALESCE(SUM(x.tips), 0)::int AS "tipsCents",
             COALESCE(SUM(x.reversed), 0)::int AS "reversedCents"
        FROM (
          -- Cobros con tarjeta / datáfono. Lo descontado incluye la deuda de
          -- devoluciones llegadas con ella ya pagada (como «Parte chica» del CSV).
          SELECT p."amountCents" + p."tipCents" AS charged, e."commissionCents" AS commission,
                 e."tipCents" AS tips, e."reversedCents" + ${afterPayoutDebt('e')} AS reversed
            FROM operator_earnings e
            JOIN payments p ON p.id = e."paymentId"
           WHERE e."tenantId" = ${tenantId}::uuid
             AND e."operatorId" = ${operatorId}::uuid
             AND ${paymentAt('p')} >= ${from}
             AND ${paymentAt('p')} < ${to}
          UNION ALL
          -- Lo que cobró del saldo del cliente. Los anulados no cuentan (como
          -- en el informe de la gestoría): ni cobro, ni comisión, ni descuento.
          SELECT c."amountCents" + c."tipCents", e."commissionCents", e."tipCents", e."reversedCents"
            FROM operator_earnings e
            JOIN wallet_consumptions c ON c.id = e."consumptionId"
           WHERE e."tenantId" = ${tenantId}::uuid
             AND e."operatorId" = ${operatorId}::uuid
             AND c."reversedAt" IS NULL
             AND c."createdAt" >= ${from}
             AND c."createdAt" < ${to}
        ) x
    `);
    const r = rows[0] ?? { count: 0, chargedCents: 0, commissionCents: 0, tipsCents: 0, reversedCents: 0 };
    const unpaid = await this.unpaidSplit(tenantId, operatorId, from, to);
    return {
      from: from.toISOString(),
      to: last?.closedAt?.toISOString() ?? null,
      nightOpen: Boolean(open),
      ...r,
      netCents: r.commissionCents + r.tipsCents - r.reversedCents,
      ...unpaid,
    };
  }

  /**
   * Lo que aún no se le ha pagado a la chica, partido en esta noche y el
   * resto (otras noches). Misma fecha de cada cobro que en `mine`: la del
   * banco en tarjeta y datáfono, la del consumo en el saldo.
   */
  private async unpaidSplit(
    tenantId: string,
    operatorId: string,
    from: Date,
    to: Date,
  ): Promise<{ unpaidCents: number; otherUnpaidCents: number }> {
    const rows = await this.prisma.asSystem((tx) => tx.$queryRaw<
      Array<{ unpaidCents: number | null; otherUnpaidCents: number | null }>
    >`
      SELECT COALESCE(SUM(x.net) FILTER (WHERE x.at >= ${from} AND x.at < ${to}), 0)::int AS "unpaidCents",
             COALESCE(SUM(x.net) FILTER (WHERE NOT (x.at >= ${from} AND x.at < ${to})), 0)::int AS "otherUnpaidCents"
        FROM (
          SELECT e."commissionCents" + COALESCE(e."tipCents", 0) - e."reversedCents" AS net,
                 COALESCE(${paymentAt('p')}, c."createdAt", e."createdAt") AS at
            FROM operator_earnings e
            LEFT JOIN payments p ON p.id = e."paymentId"
            LEFT JOIN wallet_consumptions c ON c.id = e."consumptionId"
           WHERE e."tenantId" = ${tenantId}::uuid
             AND e."operatorId" = ${operatorId}::uuid
             AND e."payoutId" IS NULL
        ) x
    `);
    return {
      unpaidCents: Number(rows[0]?.unpaidCents ?? 0),
      otherUnpaidCents: Number(rows[0]?.otherUnpaidCents ?? 0),
    };
  }

  /**
   * Cierra las noches que nadie cerró antes de las 08:00 (de un local o de
   * todos). El Z cubre hasta las 08:00. Devuelve cuántas se cerraron.
   */
  async autoCloseDue(tenantId?: string, now: Date = new Date()): Promise<number> {
    const open = await this.prisma.asSystem((tx) =>
      tx.venueNight.findMany({ where: { closedAt: null, ...(tenantId ? { tenantId } : {}) } }),
    );
    let closedCount = 0;
    for (const night of open) {
      const cutoff = autoCloseAt(night.openedAt, now);
      if (!cutoff) continue;
      // Cada noche por separado: un local con un fallo no bloquea a los demás.
      try {
        const start = await this.zBounds(night.tenantId, night.openedAt);
        const window = { from: start.from, to: cutoff };
        const pending = await this.pending(night.tenantId, window);
        // Por fecha, hasta las 08:00; por cuándo se apuntó, hasta ahora (el
        // corte de este Z: el siguiente busca ajustes desde aquí).
        await this.settleBeforeCutoff(night.id, now);
        // Nadie contó la caja: el Z lleva lo que debería haber, sin contado
        // (de las mismas filas que el Z).
        const rows = await this.zRows(night.tenantId, window, now, start.since);
        const cash = cashFromRows(night.openingFloatCents, rows);
        const caja = buildNightCaja(cash, evaluateCash(cash), null, now);
        const z = await this.withMoneyMap(
          night.tenantId,
          night.id,
          window,
          now,
          this.zFrom(window, rows, pending.count, now, start.since, caja),
        );
        const closed = await this.markClosed(night.id, night.tenantId, {
          closedAt: cutoff,
          closedBy: null,
          autoClosed: true,
          pendingAtClose: pending.count,
          closeNote: AUTO_CLOSE_NOTE,
          z,
          cash: cashColumns(caja),
        });
        if (closed) {
          closedCount += 1;
          this.logger.warn(
            `Noche ${night.id} del local ${night.tenantId} cerrada sola a las 08:00 (${pending.count} cobros sin resolver)`,
          );
        }
      } catch (err) {
        this.logger.error(`No se pudo cerrar sola la noche ${night.id}: ${(err as Error).message}`);
      }
    }
    return closedCount;
  }

  /**
   * Antes de congelar un Z con corte `cutoff`: que se vea todo lo apuntado
   * antes del corte (night-cutoff.ts). Si algo sigue abierto pasados 6 s, se
   * congela igual y se avisa en el registro.
   */
  private async settleBeforeCutoff(nightId: string, cutoff: Date): Promise<void> {
    const result = await settleWritesBefore(this.prisma, cutoff);
    if (result.settled) return;
    this.logger.warn(
      `Noche ${nightId}: ${result.open} transacción(es) de antes del corte ${cutoff.toISOString()} siguen abiertas tras ${result.waitedMs} ms; el Z se congela igual`,
    );
  }

  /** En las consultas del panel: si el cierre automático falla, la página sigue funcionando. */
  private async safeAutoClose(tenantId: string): Promise<void> {
    try {
      await this.autoCloseDue(tenantId);
    } catch (err) {
      this.logger.error(`Cierre automático de noches del local ${tenantId}: ${(err as Error).message}`);
    }
  }

  /**
   * Desde dónde cuenta el Z de una noche (desde el cierre de la anterior,
   * como el Z de una caja; la primera noche, desde que se abrió) y desde
   * cuándo busca ajustes (desde que se generó el Z anterior): night-rules.zStart.
   */
  private async zBounds(tenantId: string, openedAt: Date): Promise<{ from: Date; since: Date }> {
    const previous = await this.prisma.asSystem((tx) =>
      tx.venueNight.findFirst({
        where: { tenantId, closedAt: { not: null, lte: openedAt } },
        orderBy: { closedAt: 'desc' },
        select: { closedAt: true, zReport: true },
      }),
    );
    return zStart(previous, openedAt);
  }

  private async openNight(tenantId: string): Promise<NightRow | null> {
    return this.prisma.venueNight.findFirst({ where: { tenantId, closedAt: null } });
  }

  private async view(night: NightRow): Promise<NightView> {
    const now = new Date();
    const start = night.closedAt === null ? await this.zBounds(night.tenantId, night.openedAt) : null;
    const window = start ? { from: start.from, to: now } : null;
    const pending = window ? await this.pending(night.tenantId, window) : { items: [], count: 0 };
    const z =
      window && start
        ? await this.buildZ(night.tenantId, window, pending.count, now, start.since)
        : (night.zReport as unknown as NightZ);
    return {
      id: night.id,
      openedAt: night.openedAt.toISOString(),
      closedAt: night.closedAt?.toISOString() ?? null,
      autoClosed: night.autoClosed,
      pendingAtClose: night.pendingAtClose,
      closeNote: night.closeNote,
      openingFloatCents: night.openingFloatCents,
      z,
      pending: pending.items,
    };
  }

  /**
   * Cambiar al cerrar el fondo que se apuntó al abrir: solo el dueño, con su
   * 2FA (si no, el paso «Efectivo» bloquea: evaluateCash). Sin cambio, nada.
   */
  private async floatChangeApproved(
    actor: { userId: string; role: string },
    recordedFloatCents: number | null,
    opts: CloseNightOptions,
  ): Promise<boolean> {
    const typed = opts.openingFloatCents;
    if (typed === undefined || recordedFloatCents === null || typed === recordedFloatCents) return false;
    if (actor.role !== 'OWNER' || !opts.totpCode) return false;
    if (!this.totp) throw new ForbiddenException('No se puede comprobar el 2FA: cambia el fondo más tarde');
    if (!(await this.totp.isEnabled(actor.userId))) {
      throw totpForbidden('notEnrolled', 'Cambiar el fondo apuntado al abrir: activa antes la app de verificación (2FA).');
    }
    await this.totp.assertForUser(actor.userId, opts.totpCode);
    return true;
  }

  /**
   * Z de la noche tal como está en `now` (lo apuntado después irá como ajuste
   * del Z siguiente), los ajustes de noches anteriores apuntados desde
   * `since` y, al cerrar, la caja.
   */
  private async buildZ(
    tenantId: string,
    window: TimeWindow,
    pendingCount: number,
    now: Date,
    since: Date,
    caja?: NightCaja,
  ): Promise<NightZ> {
    return this.zFrom(window, await this.zRows(tenantId, window, now, since), pendingCount, now, since, caja);
  }

  /** El Z (puro) a partir de sus filas. */
  private zFrom(
    window: TimeWindow,
    rows: ZRows,
    pendingCount: number,
    now: Date,
    since: Date,
    caja?: NightCaja,
  ): NightZ {
    const summary = summarize(
      rows.cobros,
      rows.devoluciones,
      rows.liquidaciones,
      rows.consumos,
      rows.pagosSaldo,
      rows.recargasEfectivo,
    );
    const adjustments = buildAdjustments({ before: window.from, since, rows: rows.late });
    return { ...buildNightZ(window, summary, pendingCount, now, adjustments, caja), fichas: rows.fichas };
  }

  /**
   * El Z con el mapa del dinero congelado (con su misma ventana, su corte y
   * su caja). Si el mapa falla, la noche se cierra igual (sin él): el panel lo
   * calcula luego con la ventana del Z.
   */
  private async withMoneyMap(tenantId: string, nightId: string, window: TimeWindow, now: Date, z: NightZ): Promise<NightZ> {
    if (!this.moneyMap) return z;
    try {
      const moneyMap = await this.moneyMap.compute(tenantId, window, {
        scope: { kind: 'night', nightId, open: false },
        now,
        recordedBefore: now,
        openingFloatCents: z.caja?.openingFloatCents ?? null,
        ...(z.caja ? { cash: z.caja } : {}),
        withLiveBalances: true,
        frozen: true,
      });
      return { ...z, moneyMap };
    } catch (err) {
      this.logger.error(`Noche ${nightId}: no se pudo congelar el mapa del dinero en el Z: ${(err as Error).message}`);
      return z;
    }
  }

  /** Las filas del Z de la noche en `now`. */
  private async zRows(tenantId: string, window: TimeWindow, now: Date, since: Date): Promise<ZRows> {
    const asOf = { recordedBefore: now };
    const [cobros, devoluciones, liquidaciones, consumos, pagosSaldo, recargasEfectivo, late, fichas] = await Promise.all([
      this.reports.cobros(tenantId, window, asOf),
      this.reports.devoluciones(tenantId, window, asOf),
      this.reports.liquidaciones(tenantId, window),
      this.reports.consumos(tenantId, window, asOf),
      this.reports.pagosSaldo(tenantId, window),
      this.reports.recargasEfectivo(tenantId, window, asOf),
      this.reports.ajustes(tenantId, { before: window.from, since, until: now }),
      // Fichas de la noche: al cerrar se congelan en el Z (sus fechas cambian si se vuelven a dar).
      this.prisma.acrossVenues((tx) => fichasCounts(tx, tenantId, window)),
    ]);
    return { cobros, devoluciones, liquidaciones, consumos, pagosSaldo, recargasEfectivo, late, fichas };
  }

  /**
   * Cobros de la noche sin resolver: atascados con el banco o datáfono sin
   * confirmar (night-rules.unresolvedPaymentsWhere).
   */
  private async pending(tenantId: string, window: TimeWindow): Promise<PendingResult> {
    const rows = await this.prisma.$queryRaw<Array<PendingPayment & { total: number }>>`
      SELECT id, status::text AS status, "amountCents", "createdAt", "captureMethod",
             (COUNT(*) OVER ())::int AS total
        FROM payments
       WHERE ${unresolvedPaymentsWhere(tenantId, window)}
       ORDER BY "createdAt" ASC
       LIMIT ${PENDING_LIST_LIMIT}
    `;
    return {
      items: rows.map(({ total: _total, ...p }) => p),
      count: rows[0]?.total ?? 0,
    };
  }

  /** Cierre condicionado a que siga abierta: dos cierres a la vez no se pisan. */
  private async markClosed(
    nightId: string,
    tenantId: string,
    data: {
      closedAt: Date;
      closedBy: string | null;
      autoClosed: boolean;
      pendingAtClose: number;
      closeNote: string | null;
      z: NightZ;
      cash: CashColumns;
    },
  ): Promise<boolean> {
    const res = await this.prisma.asSystem((tx) =>
      tx.venueNight.updateMany({
        where: { id: nightId, tenantId, closedAt: null },
        data: {
          closedAt: data.closedAt,
          closedBy: data.closedBy,
          autoClosed: data.autoClosed,
          pendingAtClose: data.pendingAtClose,
          closeNote: data.closeNote,
          zReport: data.z as unknown as Prisma.InputJsonValue,
          ...data.cash,
        },
      }),
    );
    return res.count > 0;
  }
}

/** Columnas de caja de venue_nights a partir del bloque «Caja» del Z. */
function cashColumns(caja: NightCaja): CashColumns {
  return {
    openingFloatCents: caja.openingFloatCents,
    cashCountedCents: caja.countedCents,
    cashExpectedCents: caja.expectedCents,
    cashDiffCents: caja.diffCents,
    cashNote: caja.note,
  };
}

/**
 * 409 con los pasos si alguno bloquea o hay avisos sin confirmar; 400 si
 * falta explicar por qué se cierra con cobros sin terminar.
 */
function assertCanClose(
  steps: NightCloseStep[],
  acknowledged: ReadonlyArray<NightCloseStepKey>,
  note: string | undefined,
): void {
  const refusal = nightCloseRefusal(steps, acknowledged, note);
  if (!refusal) return;
  if (refusal.kind === 'note-required') {
    throw new BadRequestException({
      message: 'Explica en la nota por qué cierras con cobros sin terminar',
      code: 'NIGHT_CLOSE_NOTE_REQUIRED',
    });
  }
  const what = refusal.steps.map((s) => `${s.title}: ${s.detail}`).join(' ');
  throw new ConflictException({
    message: `${CLOSE_REFUSAL_HINT[refusal.kind]} ${what}`,
    code: refusal.kind === 'blocked' ? 'NIGHT_CLOSE_BLOCKED' : 'NIGHT_CLOSE_NEEDS_ACK',
    steps,
    missing: refusal.steps.map((s) => s.key),
  });
}
