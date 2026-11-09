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
/** Lo que llega se recorta: nunca un volcado entero, ni tokens de una URL. */
const MAX_MESSAGE = 200;

/**
 * Una app se ha roto en el móvil de alguien (la pantalla de fallo, error.tsx):
 * hasta ahora nadie se enteraba. Queda en el registro y en la métrica, y por
 * Telegram una vez por hora cada fallo distinto. Sin datos de nadie: la app,
 * el mensaje recortado, la ruta sin consulta y la versión.
 */
@Injectable()
export class ClientErrorsService {
  private readonly logger = new Logger(ClientErrorsService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(TelegramService) private readonly telegram: TelegramService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  async report(input: ClientErrorReport): Promise<void> {
    const message = cleanMessage(input.message);
    const path = cleanPath(input.path);
    const fingerprint = createHash('sha256')
      .update(`${input.app}|${input.digest ?? ''}|${message}`)
      .digest('hex')
      .slice(0, 16);
    this.metrics.clientErrors.inc({ app: input.app });
    this.logger.warn(`Fallo en ${input.app}${path ? ` (${path})` : ''}: ${message} [${fingerprint}${input.build ? ` · ${input.build}` : ''}]`);
    if (!this.telegram.isConfigured()) return;
    const first = await this.redis
      .set(`np:client-error:${fingerprint}`, '1', 'EX', ALERT_EVERY_S, 'NX')
      .catch(() => null);
    if (first !== 'OK') return;
    await this.telegram.send(
      `⚠️ Ha fallado ${CLIENT_ERROR_APPS[input.app]}${path ? ` en ${path}` : ''}: «${message}». Quien lo vio tenía un botón para volver. Si se repite, avisa.`,
    );
  }
}

/** Una línea, sin direcciones de correo ni cadenas largas que parezcan tokens. */
export function cleanMessage(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  const masked = oneLine.replace(/[^\s@]+@[^\s@]+/g, '…@…').replace(/[A-Za-z0-9_-]{24,}/g, '…');
  return (masked || 'sin mensaje').slice(0, MAX_MESSAGE);
}

/** Solo la ruta, y sin los tokens de /w/…, /pay/…, /s/…, /r/… ni ?saldo=. */
export function cleanPath(raw: string | undefined): string | null {
  if (!raw) return null;
  const path = raw.split(/[?#]/)[0] ?? '';
  return path.replace(/[A-Za-z0-9_-]{12,}/g, '…').slice(0, 80) || '/';
}
