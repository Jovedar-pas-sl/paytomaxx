import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { lastNightCutoff, madridAt, madridDay } from '../../common/time/madrid';
import { summarize } from '../reports/export-csv';
import { ReportsService } from '../reports/reports.service';
import { incidentMessage, morningSummaryMessage } from './alert-messages';
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
    if (!this.telegram.isConfigured()) {
      this.logger.log('Alertas por Telegram desactivadas (faltan TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)');
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
        select: { id: true, name: true },
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

  private async alertVenue(venue: { id: string; name: string }, now: Date): Promise<void> {
    const open = await this.incidents.list(venue.id, now);
    const fresh = open.filter((i) => now.getTime() - new Date(i.occurredAt).getTime() <= ALERT_FRESH_MS);
    let sent = 0;
    for (const incident of fresh) {
      if (sent >= MAX_ALERTS_PER_TICK) break;
      const key = `np:alert:${venue.id}:${incident.kind}:${incident.refId}`;
      if (await this.sendOnce(key, ALERT_SENT_TTL_S, () => incidentMessage(venue.name, incident))) sent += 1;
    }

    const today = madridDay(now);
    if (now < madridAt(today, SUMMARY_HOUR) || now >= madridAt(today, SUMMARY_LAST_HOUR)) return;
    // La noche anterior: de las 08:00 de ayer a las 08:00 de hoy (como el cierre automático).
    const to = lastNightCutoff(now);
    const from = lastNightCutoff(new Date(to.getTime() - 1));
    const window = { from, to };
    const [cobros, devoluciones, liquidaciones] = await Promise.all([
      this.reports.cobros(venue.id, window),
      this.reports.devoluciones(venue.id, window),
      this.reports.liquidaciones(venue.id, window),
    ]);
    const summary = summarize(cobros, devoluciones, liquidaciones);
    if (summary.count === 0 && open.length === 0) return; // local cerrado y nada pendiente
    await this.sendOnce(`np:summary:${venue.id}:${today}`, 2 * 24 * 60 * 60, () =>
      morningSummaryMessage(venue.name, summary, open.length),
    );
  }

  /**
   * Envía una sola vez: se reserva la marca en Redis (SET NX) y, si Telegram
   * falla, se quita para reintentar en la siguiente vuelta.
   */
  private async sendOnce(key: string, ttlSeconds: number, message: () => string): Promise<boolean> {
    if ((await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX')) !== 'OK') return false;
    let ok = false;
    try {
      ok = await this.telegram.send(message());
    } finally {
      if (!ok) await this.redis.del(key);
    }
    return ok;
  }
}
