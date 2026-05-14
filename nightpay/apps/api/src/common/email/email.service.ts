import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface SendEmailResult {
  ok: boolean;
  /** True si se envió por el provider real (Resend). False = NoOp. */
  delivered: boolean;
  reason?: string;
}

/**
 * Email abstraction. Inyectable como token EmailService.
 *
 * - Si `RESEND_API_KEY` está set → usa la API HTTP de Resend (sin SDK,
 *   solo fetch para no añadir dependencia más).
 * - Si no → modo NoOp: loguea y devuelve `delivered: false`. El caller
 *   (createOperator) trata `delivered: false` como señal de que debe
 *   mostrar el inviteUrl al admin para envío manual via WhatsApp.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly apiKey: string | undefined;
  private readonly fromAddress: string;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.apiKey = config.get<string>('RESEND_API_KEY');
    this.fromAddress = config.get<string>('EMAIL_FROM') ?? 'NightPay <noreply@paytomaxx.com>';
  }

  isEnabled(): boolean {
    return Boolean(this.apiKey);
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (!this.apiKey) {
      this.logger.log(`[NoOp] Email skipped to=${input.to} subject="${input.subject}"`);
      return { ok: true, delivered: false, reason: 'RESEND_API_KEY not set' };
    }

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.fromAddress,
          to: [input.to],
          subject: input.subject,
          html: input.html,
          text: input.text,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        this.logger.warn(
          `Resend send failed status=${res.status} body=${body.slice(0, 200)} to=${input.to}`,
        );
        return { ok: false, delivered: false, reason: `resend-${res.status}` };
      }

      this.logger.log(`Email sent via Resend to=${input.to} subject="${input.subject}"`);
      return { ok: true, delivered: true };
    } catch (err) {
      // Logueamos stack completo (no solo .message) para diagnosticar failures
      // de red, DNS, certificados, etc. en producción.
      const errorObj = err instanceof Error ? err : new Error(String(err));
      this.logger.error(
        `Resend send error to=${input.to}: ${errorObj.message}`,
        errorObj.stack,
      );
      return { ok: false, delivered: false, reason: 'exception' };
    }
  }
}
