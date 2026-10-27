import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { SETTLEMENT_OVERDUE_DAYS, formatMoney } from '@nightpay/contracts';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { RELEASE_LOCK_LUA } from '../../common/redis/release-lock';
import { madridAt, madridDay } from '../../common/time/madrid';
import { TelegramService } from '../incidents/telegram.service';
import { OxioPaySettlementsService } from './oxiopay-settlements.service';
import { dueWeek } from './settlement-week';

/** Cada cuánto se mira si toca generar (el lunes desde las 10:00) o avisar. */
const TICK_EVERY_MS = 10 * 60 * 1000;
/** Primera vuelta tras arrancar (sin estorbar el arranque). */
const BOOT_DELAY_MS = 2 * 60 * 1000;
/**
 * Nunca dos vueltas a la vez entre réplicas (con start-first conviven dos un
 * rato): la que toma el candado (con un valor suyo) trabaja y lo suelta al
 * terminar, solo si sigue siendo suyo. Caduca solo si la réplica se cae. Si
 * aun así coincidieran, la base no deja dos activas por local y semana.
 */
const LOCK_KEY = 'np:oxiopay-settlements:lock';
const LOCK_TTL_S = 30 * 60;
/** Semana generada en todos los locales sin fallos: no se vuelve a repasar (dura más que la semana). */
const DONE_TTL_S = 8 * 24 * 60 * 60;
/** El aviso de las que llevan más de 7 días sin pagar: una vez al día, de 10:00 a 22:00 de Madrid. */
const ALERT_FROM_HOUR = 10;
const ALERT_UNTIL_HOUR = 22;
const ALERT_TTL_S = 2 * 24 * 60 * 60;
const ALERT_MAX_LINES = 10;

export const doneKey = (monday: string): string => `np:oxiopay-settlements:done:${monday}`;
export const alertKey = (day: string): string => `np:oxiopay-settlements:overdue:${day}`;

export interface OverdueLine {
  reference: string;
  venueName: string;
  pendingCents: number;
  daysOpen: number;
}

/** El aviso de Telegram (al chat de TELEGRAM_CHAT_ID, el del super-admin). */
export function overdueMessage(lines: readonly OverdueLine[]): string {
  const total = lines.reduce((sum, l) => sum + l.pendingCents, 0);
  const shown = lines.slice(0, ALERT_MAX_LINES).map(
    (l) => `• ${l.reference} · ${l.venueName} · ${formatMoney(l.pendingCents)} · ${l.daysOpen} días`,
  );
  const more = lines.length > ALERT_MAX_LINES ? [`(y ${lines.length - ALERT_MAX_LINES} más)`] : [];
  return [
    `OxioPay · Liquidaciones sin pagar (más de ${SETTLEMENT_OVERDUE_DAYS} días)`,
    `${lines.length} ${lines.length === 1 ? 'liquidación' : 'liquidaciones'} · pendiente ${formatMoney(total)}`,
    ...shown,
    ...more,
    'Panel → Ajustes → Super admin → Liquidaciones',
  ].join('\n');
}

/**
 * El repaso de la «Liquidación OxioPay»: el lunes desde las 10:00 de Madrid
 * (tras el corte de las 08:00 y el resumen de las 9:00) genera la semana
 * terminada de cada local; si el servidor estuvo parado, en la siguiente
 * vuelta (hasta el lunes siguiente). Y una vez al día, el aviso por Telegram
 * de las que llevan más de 7 días sin pagar.
 */
@Injectable()
export class OxioPaySettlementsCron implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OxioPaySettlementsCron.name);
  private readonly settlements: OxioPaySettlementsService;
  private readonly redis: Redis;
  private readonly telegram: TelegramService;
  private bootTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(OxioPaySettlementsService) settlements: OxioPaySettlementsService,
    @Inject(REDIS_CLIENT) redis: Redis,
    @Inject(TelegramService) telegram: TelegramService,
  ) {
    this.settlements = settlements;
    this.redis = redis;
    this.telegram = telegram;
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.NIGHTPAY_DISABLE_OXIOPAY_SETTLEMENTS === '1') return;
    this.bootTimer = setTimeout(() => void this.tick(), BOOT_DELAY_MS);
    this.bootTimer.unref();
    this.timer = setInterval(() => void this.tick(), TICK_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer);
    if (this.timer) clearInterval(this.timer);
  }

  /** Una vuelta, si esta réplica toma el candado; al terminar (también si falla), lo suelta. Nunca lanza. */
  async tick(now: Date = new Date()): Promise<void> {
    const lock = randomUUID();
    try {
      if ((await this.redis.set(LOCK_KEY, lock, 'EX', LOCK_TTL_S, 'NX')) !== 'OK') return;
      try {
        await this.generateDue(now);
        await this.alertOverdue(now);
      } finally {
        await this.redis.eval(RELEASE_LOCK_LUA, 1, LOCK_KEY, lock);
      }
    } catch (err) {
      this.logger.error(`Liquidaciones OxioPay: fallo en el repaso: ${(err as Error).message}`);
    }
  }

  /** La semana terminada, si toca y no está ya hecha en todos los locales. */
  async generateDue(now: Date): Promise<void> {
    const week = dueWeek(now);
    if (!week) return;
    if ((await this.redis.exists(doneKey(week.monday))) > 0) return;
    const result = await this.settlements.runDue(now);
    if (result.created.length > 0) {
      this.logger.log(`Liquidaciones OxioPay de la semana ${week.isoWeek}/${week.isoYear}: ${result.created.length} emitidas`);
    }
    if (result.failed.length > 0) {
      // Sin la marca: la siguiente vuelta lo intenta otra vez (lo hecho no se duplica).
      this.logger.error(`Liquidaciones OxioPay con error en ${result.failed.length} locales (p. ej. ${result.failed[0]})`);
      return;
    }
    await this.redis.set(doneKey(week.monday), '1', 'EX', DONE_TTL_S);
  }

  /** Las que llevan más de 7 días sin pagar: un aviso al día como mucho (marca SET NX; si Telegram falla, se quita). */
  async alertOverdue(now: Date): Promise<boolean> {
    if (!this.telegram.isConfigured()) return false;
    const today = madridDay(now);
    if (now < madridAt(today, ALERT_FROM_HOUR) || now >= madridAt(today, ALERT_UNTIL_HOUR)) return false;
    const key = alertKey(today);
    if ((await this.redis.exists(key)) > 0) return false;
    const overdue = await this.settlements.overdueList(now);
    if (overdue.length === 0) return false;
    if ((await this.redis.set(key, '1', 'EX', ALERT_TTL_S, 'NX')) !== 'OK') return false;
    let ok = false;
    try {
      ok = await this.telegram.send(overdueMessage(overdue));
    } finally {
      if (!ok) await this.redis.del(key);
    }
    return ok;
  }
}
