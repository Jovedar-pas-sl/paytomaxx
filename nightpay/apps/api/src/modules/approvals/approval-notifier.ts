import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { TelegramService } from '../incidents/telegram.service';
import { approvalAlertKey } from './approval-rules';

/** Lo que dura la marca de «ya avisado» (como las de Incidencias). */
const ALERT_SENT_TTL_S = 90 * 24 * 60 * 60;

/**
 * Aviso por Telegram de una solicitud nueva, una sola vez. La marca en Redis
 * es la misma que usan las alertas de Incidencias para `approval_pending`: si
 * este aviso sale, la incidencia de los 30 min no se vuelve a mandar; si
 * Telegram falla, se quita la marca y la manda la vuelta de las alertas.
 * Nunca rompe la petición del encargado.
 */
@Injectable()
export class ApprovalNotifier {
  private readonly logger = new Logger(ApprovalNotifier.name);
  private readonly redis: Redis;
  private readonly telegram: TelegramService;

  constructor(@Inject(REDIS_CLIENT) redis: Redis, @Inject(TelegramService) telegram: TelegramService) {
    this.redis = redis;
    this.telegram = telegram;
  }

  /** Sin Telegram configurado, en pruebas o con las alertas apagadas no se avisa. */
  enabled(): boolean {
    if (process.env.NODE_ENV === 'test' || process.env.NIGHTPAY_DISABLE_ALERTS === '1') return false;
    return this.telegram.hasBot();
  }

  /** `chatId`: el chat del local (Ajustes → Avisos); null = el de TELEGRAM_CHAT_ID. */
  async requested(tenantId: string, approvalId: string, text: string, chatId: string | null = null): Promise<boolean> {
    if (!this.enabled() || !this.telegram.isConfigured(chatId)) return false;
    const key = approvalAlertKey(tenantId, approvalId);
    try {
      if ((await this.redis.set(key, '1', 'EX', ALERT_SENT_TTL_S, 'NX')) !== 'OK') return false;
      const sent = await this.telegram.send(text, chatId);
      if (!sent) await this.redis.del(key);
      return sent;
    } catch (err) {
      this.logger.warn(`Aviso de la solicitud ${approvalId} sin mandar: ${(err as Error).message}`);
      return false;
    }
  }
}
