import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { alertKindForIncident, alertSettingsOf, type VenueAlertSettings } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { lastNightCutoff, madridAt, madridDay } from '../../common/time/madrid';
import { summarize, type ExportSummary } from '../reports/export-csv';
import { ReportsService } from '../reports/reports.service';
import { staleBankHolds } from '../operators/bank-hold-sql';
import { bankHoldReminderMessage, incidentMessage, morningSummaryMessage } from './alert-messages';
import { mergeSummaries, type SummaryScope } from './morning-summary';
import { IncidentsService } from './incidents.service';
import { TelegramService } from './telegram.service';

const ALERT_EVERY_MS = 5 * 60 * 1000;
/** Cada incidencia se avisa una sola vez (la marca dura más que lo que se mira atrás). */
const ALERT_SENT_TTL_S = 90 * 24 * 60 * 60;
/** Tope por local y vuelta, para no inundar el móvil (p. ej. el primer arranque). */
const MAX_ALERTS_PER_TICK = 10;
/** Hora del resumen diario (Madrid) y hasta cuándo tiene sentido mandarlo. */
const SUMMARY_HOUR = 9;
const SUMMARY_LAST_HOUR = 14;
/** Ventas por datáfono sin cuadrar con el banco: se recuerdan pasadas 24 h, una vez al día por local. */
const BANK_HOLD_STALE_MS = 24 * 60 * 60 * 1000;
/** El recordatorio sale desde esta hora de Madrid (no de madrugada, con la noche abierta). */
const BANK_HOLD_REMINDER_HOUR = SUMMARY_HOUR;
/**
 * Solo se avisa de lo reciente: al arrancar por primera vez (o si Redis se
 * vacía) no llegan de golpe las incidencias de hace semanas. Siguen en la bandeja.
 */
const ALERT_FRESH_MS = 6 * 60 * 60 * 1000;

/**
 * Alertas por Telegram (Fase 1E): cada incidencia nueva una vez, y a las
 * 9:00 el resumen de la noche anterior de cada local. Las marcas de "ya
 * enviado" van en Redis (SET NX), así varias instancias no repiten.
 */
@Injectable()
export class AlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertsService.name);
  private readonly prisma: PrismaService;
  private readonly redis: Redis;
  private readonly incidents: IncidentsService;
  private readonly reports: ReportsService;
  private readonly telegram: TelegramService;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(REDIS_CLIENT) redis: Redis,
    @Inject(IncidentsService) incidents: IncidentsService,
    @Inject(ReportsService) reports: ReportsService,
    @Inject(TelegramService) telegram: TelegramService,
  ) {
    this.prisma = prisma;
    this.redis = redis;
    this.incidents = incidents;
    this.reports = reports;
    this.telegram = telegram;
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.NIGHTPAY_DISABLE_ALERTS === '1') return;
    // Con bot basta: cada local puede tener su chat (Ajustes → Avisos de Telegram).
    if (!this.telegram.hasBot()) {
      this.logger.log('Alertas por Telegram desactivadas (falta TELEGRAM_BOT_TOKEN)');
      return;
    }
    this.timer = setInterval(() => void this.tick(), ALERT_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Una vuelta: avisos nuevos y, de 9:00 a 14:00, el resumen del día. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.running) return; // la anterior aún no ha terminado (BD lenta)
    this.running = true;
    try {
      const venues = await this.prisma.venue.findMany({
        where: { deletedAt: null },
        select: { id: true, name: true, alertSettings: true },
      });
      const failures: string[] = [];
      for (const venue of venues) {
        // Cada local por separado: un fallo en uno no corta los demás.
        try {
          await this.alertVenue(venue, now);
        } catch (err) {
          failures.push(`${venue.id}: ${(err as Error).message}`);
        }
      }
      if (failures.length > 0) {
        this.logger.error(`Alertas con error en ${failures.length} locales (p. ej. ${failures[0]})`);
      }
    } catch (err) {
      this.logger.error(`Alertas: no se pudo hacer la vuelta: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async alertVenue(venue: { id: string; name: string; alertSettings?: unknown }, now: Date): Promise<void> {
    // Ajustes del local: qué grupos salen, a qué chat y si llevan los nombres de las chicas.
    const settings: VenueAlertSettings = alertSettingsOf(venue.alertSettings);
    if (!this.telegram.isConfigured(settings.chatId)) return; // sin chat al que mandar
    const chatId = settings.chatId;
    const open = await this.incidents.list(venue.id, now);
    const fresh = open.filter(
      (i) =>
        now.getTime() - new Date(i.occurredAt).getTime() <= ALERT_FRESH_MS && settings.kinds[alertKindForIncident(i.kind)],
    );
    let sent = 0;
    for (const incident of fresh) {
      if (sent >= MAX_ALERTS_PER_TICK) break;
      const key = `np:alert:${venue.id}:${incident.kind}:${incident.refId}`;
      const message = () => incidentMessage(venue.name, incident, { includeNames: settings.includeNames });
      if (await this.sendOnce(key, ALERT_SENT_TTL_S, message, chatId)) sent += 1;
    }

    // Un fallo del recordatorio no se lleva por delante el resumen de las 9:00.
    try {
      await this.bankHoldReminder(venue, settings, now);
    } catch (err) {
      this.logger.warn(`Recordatorio de ventas por datáfono sin cuadrar de ${venue.id}: ${(err as Error).message}`);
    }

    if (!settings.kinds.summary) return;
    const today = madridDay(now);
    if (now < madridAt(today, SUMMARY_HOUR) || now >= madridAt(today, SUMMARY_LAST_HOUR)) return;
    const key = `np:summary:${venue.id}:${today}`;
    // Ya enviado hoy: ni se calcula (antes se calculaban los informes en cada
    // vuelta de 5 min hasta las 14:00 y se tiraban). La marca se reserva con
    // SET NX al enviar (sendOnce): dos réplicas no lo mandan dos veces.
    if ((await this.redis.exists(key)) > 0) return;
    // La noche anterior: de las 08:00 de ayer a las 08:00 de hoy (como el cierre automático).
    const to = lastNightCutoff(now);
    const from = lastNightCutoff(new Date(to.getTime() - 1));
    const window = { from, to };
    const nights = await this.closedNights(venue.id, window);
    // Con la noche cerrada, su Z congelado (lo del panel → Noches); sin ella,
    // lo apuntado de 08:00 a 08:00 (y el aviso dice que no es un Z).
    const frozen = nights.flatMap((n) => (n.summary ? [{ ...n, summary: n.summary }] : []));
    const scope: SummaryScope =
      frozen.length > 0 ? { kind: 'nights', nights: frozen.map((n) => ({ closedAt: n.closedAt, autoClosed: n.autoClosed })) } : { kind: 'window' };
    const summary = frozen.length > 0 ? mergeSummaries(frozen.map((n) => n.summary)) : await this.liveSummary(venue.id, window);
    // Diferencia de caja de las noches cerradas en ese tramo (contado − esperado).
    const cashDiff = nights.reduce((sum, n) => sum + (n.cashDiffCents ?? 0), 0);
    const quiet = summary.count === 0 && !summary.walletCashTopUpsCount;
    if (quiet && open.length === 0 && !cashDiff) return; // local cerrado y nada pendiente
    const bankFilePending = summary.count > 0 && !(await this.bankFileCovers(venue.id, madridDay(from)));
    await this.sendOnce(
      key,
      2 * 24 * 60 * 60,
      () => morningSummaryMessage(venue.name, summary, open.length, bankFilePending, cashDiff, scope),
      chatId,
    );
  }

  /**
   * Una vez al día por local (desde las 9:00 de Madrid): ventas por datáfono
   * sin cuadrar con el banco de hace más de 24 h, con su comisión retenida.
   * Va con los avisos del datáfono (Ajustes → Avisos: «pos»). La marca del día
   * en Redis (SET NX, sendOnce): dos réplicas no lo mandan dos veces.
   */
  async bankHoldReminder(
    venue: { id: string; name: string },
    settings: VenueAlertSettings,
    now: Date = new Date(),
  ): Promise<boolean> {
    if (!settings.kinds.pos) return false;
    const today = madridDay(now);
    if (now < madridAt(today, BANK_HOLD_REMINDER_HOUR)) return false;
    const key = `np:bankhold:${venue.id}:${today}`;
    if ((await this.redis.exists(key)) > 0) return false;
    const stale = await this.prisma.asSystem((tx) => staleBankHolds(tx, venue.id, new Date(now.getTime() - BANK_HOLD_STALE_MS)));
    if (stale.count === 0) return false;
    return this.sendOnce(key, 2 * 24 * 60 * 60, () => bankHoldReminderMessage(venue.name, stale), settings.chatId);
  }

  /**
   * «Avisar al encargado» desde Esperando (cobro que el banco no ha
   * confirmado): manda ya por Telegram la incidencia de ese cobro, la misma de
   * la bandeja («Cobro sin confirmar por el banco», stuck_payment), con la
   * misma marca que la vuelta de los avisos: al encargado le llega una sola
   * vez. Con los avisos de cobros apagados (o sin chat), no se manda: sigue
   * en Incidencias del panel. `sent`: le ha llegado (ahora o antes).
   */
  async notifyPaymentNow(venueId: string, paymentId: string, now: Date = new Date()): Promise<{ sent: boolean; telegram: boolean }> {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId }, select: { id: true, name: true, alertSettings: true } });
    if (!venue) return { sent: false, telegram: false };
    const settings = alertSettingsOf(venue.alertSettings);
    if (!this.telegram.isConfigured(settings.chatId)) return { sent: false, telegram: false };
    // Ya avisado (por aquí o por la vuelta de los avisos): sin recalcular las incidencias del local.
    const key = `np:alert:${venue.id}:stuck_payment:${paymentId}`;
    if ((await this.redis.exists(key)) > 0) return { sent: true, telegram: true };
    const incident = (await this.incidents.list(venueId, now)).find((i) => i.kind === 'stuck_payment' && i.refId === paymentId);
    if (!incident || !settings.kinds[alertKindForIncident(incident.kind)]) return { sent: false, telegram: true };
    const message = () => incidentMessage(venue.name, incident, { includeNames: settings.includeNames });
    if (await this.sendOnce(key, ALERT_SENT_TTL_S, message, settings.chatId)) return { sent: true, telegram: true };
    return { sent: (await this.redis.exists(key)) > 0, telegram: true };
  }

  /** Lo apuntado en el tramo, tal como está ahora (sin noche cerrada). */
  private async liveSummary(venueId: string, window: { from: Date; to: Date }): Promise<ExportSummary> {
    const [cobros, devoluciones, liquidaciones, consumos, pagosSaldo, recargasEfectivo] = await Promise.all([
      this.reports.cobros(venueId, window),
      this.reports.devoluciones(venueId, window),
      this.reports.liquidaciones(venueId, window),
      this.reports.consumos(venueId, window),
      this.reports.pagosSaldo(venueId, window),
      this.reports.recargasEfectivo(venueId, window),
    ]);
    return summarize(cobros, devoluciones, liquidaciones, consumos, pagosSaldo, recargasEfectivo);
  }

  /**
   * Noches cerradas en ese tramo, por orden de cierre, con su Z congelado y
   * su diferencia de caja. Las 08:00 entran: es la hora del cierre automático.
   */
  private async closedNights(
    venueId: string,
    window: { from: Date; to: Date },
  ): Promise<Array<{ closedAt: Date; autoClosed: boolean; cashDiffCents: number | null; summary: ExportSummary | null }>> {
    const nights = await this.prisma.asSystem((tx) =>
      tx.venueNight.findMany({
        where: { tenantId: venueId, closedAt: { gt: window.from, lte: window.to } },
        orderBy: { closedAt: 'asc' },
        select: { closedAt: true, autoClosed: true, cashDiffCents: true, zReport: true },
      }),
    );
    return nights.map((n) => ({
      closedAt: n.closedAt!,
      autoClosed: n.autoClosed,
      cashDiffCents: n.cashDiffCents,
      summary: frozenSummaryOf(n.zReport),
    }));
  }

  /** ¿Algún local del grupo ya subió un fichero del banco que cubre ese día? */
  private async bankFileCovers(venueId: string, day: string): Promise<boolean> {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId }, select: { walletGroup: true } });
    const venueIds = venue?.walletGroup
      ? (await this.prisma.venue.findMany({ where: { walletGroup: venue.walletGroup }, select: { id: true } })).map(
          (v) => v.id,
        )
      : [venueId];
    const dayDate = new Date(`${day}T00:00:00Z`);
    const found = await this.prisma.acrossVenues((tx) =>
      tx.bankStatement.findFirst({
        where: { tenantId: { in: venueIds }, periodFrom: { lte: dayDate }, periodTo: { gte: dayDate } },
        select: { id: true },
      }),
    );
    return found !== null;
  }

  /**
   * Envía una sola vez: se reserva la marca en Redis (SET NX) y, si Telegram
   * falla, se quita para reintentar en la siguiente vuelta.
   */
  private async sendOnce(
    key: string,
    ttlSeconds: number,
    message: () => string,
    chatId: string | null = null,
  ): Promise<boolean> {
    if ((await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX')) !== 'OK') return false;
    let ok = false;
    try {
      ok = await this.telegram.send(message(), chatId);
    } finally {
      if (!ok) await this.redis.del(key);
    }
    return ok;
  }
}

/** El resumen congelado de un Z (zReport.summary), si lo tiene. */
function frozenSummaryOf(zReport: unknown): ExportSummary | null {
  if (!zReport || typeof zReport !== 'object') return null;
  const summary = (zReport as { summary?: unknown }).summary;
  return summary && typeof summary === 'object' && typeof (summary as ExportSummary).count === 'number'
    ? (summary as ExportSummary)
    : null;
}
