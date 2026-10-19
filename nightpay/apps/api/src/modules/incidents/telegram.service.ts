import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const TELEGRAM_TIMEOUT_MS = 5000;

/**
 * Mensajes al Telegram del dueño (Fase 1E). Sin TELEGRAM_BOT_TOKEN no envía
 * nada. Cada local puede tener su chat (Ajustes → Avisos de Telegram); si no,
 * va al de TELEGRAM_CHAT_ID. Un fallo de Telegram nunca rompe nada: se apunta
 * en el log (sin el token) y se sigue.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly config: ConfigService;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.config = config;
  }

  /** Hay bot y un chat al que mandar (el del local o, sin él, el del entorno). */
  isConfigured(chatId?: string | null): boolean {
    return Boolean(this.token() && (chatId || this.chatId()));
  }

  /** Hay bot (los locales con chat propio pueden recibir aunque no haya chat por defecto). */
  hasBot(): boolean {
    return Boolean(this.token());
  }

  /** Al chat del local (`chatId`) o, sin él, al de TELEGRAM_CHAT_ID. */
  async send(text: string, venueChatId?: string | null): Promise<boolean> {
    const token = this.token();
    const chatId = venueChatId || this.chatId();
    if (!token || !chatId) return false;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(`Telegram respondió ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`Telegram no disponible: ${(err as Error).name}`);
      return false;
    }
  }

  private token(): string | undefined {
    return this.config.get<string>('TELEGRAM_BOT_TOKEN')?.trim() || undefined;
  }

  private chatId(): string | undefined {
    return this.config.get<string>('TELEGRAM_CHAT_ID')?.trim() || undefined;
  }
}
