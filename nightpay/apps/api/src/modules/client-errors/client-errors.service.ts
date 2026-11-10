import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { MetricsService } from '../metrics/metrics.service';
import { TelegramService } from '../incidents/telegram.service';

/** Las apps que pintan la pantalla de fallo (Next): su nombre en el aviso. */
export const CLIENT_ERROR_APPS = {
  operator: 'la app del personal',
  admin: 'el panel',
  tpv: 'el TPV',
  'web-client': 'la web del cliente',
} as const;
export type ClientErrorApp = keyof typeof CLIENT_ERROR_APPS;

/**
 * Las pantallas de cada app (el primer tramo de su ruta en Next). Solo estas
 * llegan al Telegram: la ruta la escribe quien manda el aviso, sin sesión, y
 * podría ser un texto para el dueño («/Tu~cuenta~bloqueada~llama~al~…»).
 */
export const CLIENT_ERROR_ROUTES: Record<ClientErrorApp, readonly string[]> = {
  operator: ['/', '/guia', '/accept-invite', '/onboarding', '/pax'],
  admin: ['/'],
  tpv: ['/'],
  'web-client': ['/', '/pay', '/wallet'],
};

export interface ClientErrorReport {
  app: ClientErrorApp;
  message: string;
  /** Huella que da Next del error (sin datos), si la hay. */
  digest?: string;
  /** Solo la ruta, sin la consulta: un enlace de saldo o de pago no se guarda. */
  path?: string;
  /** La versión de la app que falló (la marca del build). */
  build?: string;
}

/** El mismo fallo se avisa una vez por hora: una pantalla rota en bucle no inunda Telegram. */
const ALERT_EVERY_S = 60 * 60;
/**
 * Avisos por hora para todos los fallos juntos: el aviso no lleva sesión y
 * cualquiera puede mandarlo, así que nadie puede llenar el Telegram del dueño.
 * Al pasarlo llega un último aviso diciendo que se calla hasta la hora siguiente.
 */
export const MAX_ALERTS_PER_HOUR = 10;
/** Lo que llega se recorta: nunca un volcado entero, ni tokens de una URL. */
const MAX_MESSAGE = 200;

/**
 * Una app se ha roto en el móvil de alguien (la pantalla de fallo, error.tsx):
 * hasta ahora nadie se enteraba. Queda en el registro y en la métrica, y por
 * Telegram una vez por hora cada fallo distinto, con un tope por hora para
 * todos. Sin datos de nadie: la app, el mensaje recortado, la ruta sin
 * consulta y la versión. El mensaje y la ruta completa van al registro, no al
 * Telegram: los escribe quien manda el aviso. Al Telegram, la app, la huella
 * y, si es una pantalla conocida de esa app, el primer tramo de la ruta.
 */
@Injectable()
export class ClientErrorsService {
  private readonly logger = new Logger(ClientErrorsService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(TelegramService) private readonly telegram: TelegramService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  async report(input: ClientErrorReport, now: Date = new Date()): Promise<void> {
    const message = cleanMessage(input.message);
    const path = cleanPath(input.path);
    const build = input.build ? oneLine(input.build).slice(0, 64) : null;
    const fingerprint = fingerprintOf(input.app, input.digest, message);
    this.metrics.clientErrors.inc({ app: input.app });
    this.logger.warn(`Fallo en ${input.app}${path ? ` (${path})` : ''}: ${message} [${fingerprint}${build ? ` · ${build}` : ''}]`);
    if (!this.telegram.isConfigured()) return;
    const first = await this.redis
      .set(`np:client-error:${fingerprint}`, '1', 'EX', ALERT_EVERY_S, 'NX')
      .catch(() => null);
    if (first !== 'OK') return;
    const sent = await this.countAlert(now);
    if (sent === null || sent > MAX_ALERTS_PER_HOUR + 1) return;
    if (sent === MAX_ALERTS_PER_HOUR + 1) {
      await this.telegram.send(
        `⚠️ Muchos fallos de pantalla esta hora: dejo de avisar hasta la siguiente. El detalle sigue en el registro del API.`,
      );
      return;
    }
    const route = telegramRoute(input.app, path);
    const where = route ? ` en ${route}` : '';
    await this.telegram.send(
      `⚠️ Ha fallado ${CLIENT_ERROR_APPS[input.app]}${where}. Quien lo vio tenía un botón para volver. Si se repite, avisa. Detalle en el registro del API (huella ${fingerprint}).`,
    );
  }

  /** Cuántos avisos van esta hora (null sin Redis: entonces no se avisa). */
  private async countAlert(now: Date): Promise<number | null> {
    const key = `np:client-error:tg:${Math.floor(now.getTime() / (ALERT_EVERY_S * 1000))}`;
    const n = await this.redis.incr(key).catch(() => null);
    if (n === 1) await this.redis.expire(key, ALERT_EVERY_S).catch(() => null);
    return n;
  }
}

/** Sin saltos de línea ni caracteres de control: una línea falsa no se cuela en el registro. */
function oneLine(raw: string): string {
  return raw.replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** La huella: la app, la de Next y el mensaje sin números (el mismo fallo con otra cifra es el mismo). */
function fingerprintOf(app: ClientErrorApp, digest: string | undefined, message: string): string {
  const shape = message.replace(/\d+/g, '#').slice(0, 120);
  return createHash('sha256').update(`${app}|${digest ?? ''}|${shape}`).digest('hex').slice(0, 16);
}

/** Una línea, sin enlaces, direcciones de correo ni cadenas largas que parezcan tokens. */
export function cleanMessage(raw: string): string {
  const masked = oneLine(raw)
    .replace(/https?:\/\/\S+/g, '[enlace]')
    .replace(/[^\s@]+@[^\s@]+/g, '…@…')
    .replace(/[A-Za-z0-9_-]{20,}/g, '…');
  return (masked || 'sin mensaje').slice(0, MAX_MESSAGE);
}

/** Solo la ruta, sin espacios, y sin los tokens de /w/…, /pay/…, /s/…, /r/… ni ?saldo=. */
export function cleanPath(raw: string | undefined): string | null {
  if (!raw) return null;
  const path = (raw.split(/[?#]/)[0] ?? '').replace(/[^\x21-\x7E]/g, '');
  return path.replace(/[A-Za-z0-9_-]{12,}/g, '…').slice(0, 80) || '/';
}

/** La ruta para el Telegram: su primer tramo, solo si es una pantalla de esa app (null: no se dice). */
export function telegramRoute(app: ClientErrorApp, path: string | null): string | null {
  if (!path) return null;
  const first = `/${path.split('/')[1] ?? ''}`;
  return CLIENT_ERROR_ROUTES[app].includes(first) ? first : null;
}
