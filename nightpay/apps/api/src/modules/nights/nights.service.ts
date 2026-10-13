import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { lastNightCutoff } from '../../common/time/madrid';
import { AuditService } from '../audit/audit.service';
import { summarize } from '../reports/export-csv';
import type { TimeWindow } from '../reports/report-period';
import { ReportsService } from '../reports/reports.service';
import { autoCloseAt, buildNightZ, decideClose, type NightZ } from './night-rules';

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
  /** Congelado si la noche está cerrada; en vivo si está abierta. */
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
}

type NightRow = {
  id: string;
  tenantId: string;
  openedAt: Date;
  closedAt: Date | null;
  autoClosed: boolean;
  pendingAtClose: number;
  closeNote: string | null;
  zReport: Prisma.JsonValue | null;
};

const AUTO_CLOSE_NOTE = 'Cierre automático a las 08:00';

/** Tras cerrar, la chica sigue viendo esa noche durante este tiempo. */
const LAST_NIGHT_VISIBLE_MS = 16 * 60 * 60 * 1000;

/** Cuántos cobros pendientes se listan (el número total va aparte). */
const PENDING_LIST_LIMIT = 100;

interface PendingResult {
  items: PendingPayment[];
  count: number;
}

/**
 * Noche del local (Fase 1D): se abre, se cierra con informe Z congelado y
 * resumen por chica, y no se cierra con cobros sin resolver. Las cuentas son
 * las mismas que las del informe de la gestoría (ReportsService + summarize).
 */
@Injectable()
export class NightsService {
  private readonly logger = new Logger(NightsService.name);
  private readonly prisma: PrismaService;
  private readonly reports: ReportsService;
  private readonly audit: AuditService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(ReportsService) reports: ReportsService,
    @Inject(AuditService) audit: AuditService,
  ) {
    this.prisma = prisma;
    this.reports = reports;
    this.audit = audit;
  }

  async current(tenantId: string): Promise<NightView | null> {
    await this.safeAutoClose(tenantId);
    const night = await this.openNight(tenantId);
    return night ? this.view(night) : null;
  }

  async open(tenantId: string, userId: string): Promise<NightView> {
    await this.safeAutoClose(tenantId);
    let night: NightRow;
    try {
      night = await this.prisma.venueNight.create({ data: { tenantId, openedBy: userId } });
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
      payload: { openedAt: night.openedAt.toISOString() },
    });
    return this.view(night);
  }

  async close(
    tenantId: string,
    actor: { userId: string; role: string },
    nightId: string,
    opts: { force: boolean; note?: string },
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

    const now = new Date();
    const window = { from: await this.zFrom(tenantId, night.openedAt), to: now };
    const pending = await this.pending(tenantId, window);
    const decision = decideClose({ pendingCount: pending.count, force: opts.force, role: actor.role, note: opts.note });
    if (!decision.ok) {
      if (decision.reason === 'pending') {
        throw new ConflictException(
          `${pending.count === 1 ? 'Queda 1 cobro' : `Quedan ${pending.count} cobros`} sin resolver. Resuélvelos en Pagos o, si eres el dueño, cierra igualmente con una nota.`,
        );
      }
      if (decision.reason === 'force-owner-only') {
        throw new ForbiddenException('Solo el dueño puede cerrar la noche con cobros sin resolver');
      }
      throw new BadRequestException('Explica en la nota por qué cierras con cobros sin resolver');
    }

    const z = await this.buildZ(tenantId, window, pending.count, now);
    const closed = await this.markClosed(night.id, tenantId, {
      closedAt: now,
      closedBy: actor.userId,
      autoClosed: false,
      pendingAtClose: pending.count,
      closeNote: opts.note?.trim() || null,
      z,
    });
    if (!closed) throw new ConflictException('Esta noche ya está cerrada (puede que se cerrara sola a las 08:00)');

    await this.audit.log({
      action: 'night.closed',
      tenantId,
      actorId: actor.userId,
      targetType: 'VenueNight',
      targetId: night.id,
      payload: { forced: opts.force, pendingAtClose: pending.count, netCents: z.summary.netCents },
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
    const rows = await this.prisma.$queryRaw<
      Array<{ count: number; chargedCents: number; commissionCents: number; tipsCents: number; reversedCents: number }>
    >`
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM(p."amountCents" + p."tipCents"), 0)::int AS "chargedCents",
             COALESCE(SUM(e."commissionCents"), 0)::int AS "commissionCents",
             COALESCE(SUM(e."tipCents"), 0)::int AS "tipsCents",
             COALESCE(SUM(e."reversedCents"), 0)::int AS "reversedCents"
        FROM operator_earnings e
        JOIN payments p ON p.id = e."paymentId"
       WHERE e."tenantId" = ${tenantId}::uuid
         AND e."operatorId" = ${operatorId}::uuid
         AND COALESCE(p."authorizedAt", p."createdAt") >= ${from}
         AND COALESCE(p."authorizedAt", p."createdAt") < ${to}
    `;
    const r = rows[0] ?? { count: 0, chargedCents: 0, commissionCents: 0, tipsCents: 0, reversedCents: 0 };
    return {
      from: from.toISOString(),
      to: last?.closedAt?.toISOString() ?? null,
      nightOpen: Boolean(open),
      ...r,
      netCents: r.commissionCents + r.tipsCents - r.reversedCents,
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
        const window = { from: await this.zFrom(night.tenantId, night.openedAt), to: cutoff };
        const pending = await this.pending(night.tenantId, window);
        const z = await this.buildZ(night.tenantId, window, pending.count, now);
        const closed = await this.markClosed(night.id, night.tenantId, {
          closedAt: cutoff,
          closedBy: null,
          autoClosed: true,
          pendingAtClose: pending.count,
          closeNote: AUTO_CLOSE_NOTE,
          z,
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

  /** En las consultas del panel: si el cierre automático falla, la página sigue funcionando. */
  private async safeAutoClose(tenantId: string): Promise<void> {
    try {
      await this.autoCloseDue(tenantId);
    } catch (err) {
      this.logger.error(`Cierre automático de noches del local ${tenantId}: ${(err as Error).message}`);
    }
  }

  /**
   * Desde dónde cuenta el Z de una noche: desde el cierre de la anterior
   * (como el Z de una caja), así ningún cobro se queda fuera —por ejemplo uno
   * que el banco confirma después de cerrar—. La primera noche, desde que se abrió.
   */
  private async zFrom(tenantId: string, openedAt: Date): Promise<Date> {
    const previous = await this.prisma.asSystem((tx) =>
      tx.venueNight.findFirst({
        where: { tenantId, closedAt: { not: null, lte: openedAt } },
        orderBy: { closedAt: 'desc' },
        select: { closedAt: true },
      }),
    );
    return previous?.closedAt ?? openedAt;
  }

  private async openNight(tenantId: string): Promise<NightRow | null> {
    return this.prisma.venueNight.findFirst({ where: { tenantId, closedAt: null } });
  }

  private async view(night: NightRow): Promise<NightView> {
    const open = night.closedAt === null;
    const now = new Date();
    const window = open ? { from: await this.zFrom(night.tenantId, night.openedAt), to: now } : null;
    const pending = window ? await this.pending(night.tenantId, window) : { items: [], count: 0 };
    const z = window
      ? await this.buildZ(night.tenantId, window, pending.count, now)
      : (night.zReport as unknown as NightZ);
    return {
      id: night.id,
      openedAt: night.openedAt.toISOString(),
      closedAt: night.closedAt?.toISOString() ?? null,
      autoClosed: night.autoClosed,
      pendingAtClose: night.pendingAtClose,
      closeNote: night.closeNote,
      z,
      pending: pending.items,
    };
  }

  private async buildZ(tenantId: string, window: TimeWindow, pendingCount: number, now: Date): Promise<NightZ> {
    const [cobros, devoluciones, liquidaciones] = await Promise.all([
      this.reports.cobros(tenantId, window),
      this.reports.devoluciones(tenantId, window),
      this.reports.liquidaciones(tenantId, window),
    ]);
    return buildNightZ(window, summarize(cobros, devoluciones, liquidaciones), pendingCount, now);
  }

  /**
   * Cobros de la noche sin resolver: atascados con el banco o datáfono sin
   * confirmar. Misma fecha que el Z (sin autorizar = la de creación) y la
   * misma hora de corte para todo.
   */
  private async pending(tenantId: string, window: TimeWindow): Promise<PendingResult> {
    const rows = await this.prisma.$queryRaw<Array<PendingPayment & { total: number }>>`
      SELECT id, status::text AS status, "amountCents", "createdAt", "captureMethod",
             (COUNT(*) OVER ())::int AS total
        FROM payments
       WHERE "tenantId" = ${tenantId}::uuid
         AND COALESCE("authorizedAt", "createdAt") >= ${window.from}
         AND COALESCE("authorizedAt", "createdAt") < ${window.to}
         AND (
           status IN ('AUTHORIZING', 'ORPHAN')
           OR ("captureMethod" = 'POS_EXTERNAL'
               AND status IN ('CREATED', 'AWAITING_CAPTURE')
               AND "qrExpiresAt" > ${window.to})
         )
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
        },
      }),
    );
    return res.count > 0;
  }
}
