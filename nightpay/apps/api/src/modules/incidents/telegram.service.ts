import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const TELEGRAM_TIMEOUT_MS = 5000;

/**
 * Mensajes al Telegram del dueño (Fase 1E). Sin TELEGRAM_BOT_TOKEN y
 * TELEGRAM_CHAT_ID no envía nada. Un fallo de Telegram nunca rompe nada:
 * se apunta en el log (sin el token) y se sigue.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly config: ConfigService;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.config = config;
  }

  isConfigured(): boolean {
    return Boolean(this.token() && this.chatId());
  }

  async send(text: string): Promise<boolean> {
    const token = this.token();
    const chatId = this.chatId();
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
