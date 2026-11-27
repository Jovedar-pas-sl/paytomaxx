import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BRAND_NAME } from '../brand';

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

/** Lo más que se espera a Resend: una llamada colgada no deja colgada la página que la pidió. */
const SEND_TIMEOUT_MS = 10_000;

/**
 * La dirección para el registro, nunca entera: «m***@g***.com» (la primera
 * letra de cada parte y el final del dominio). Sin arroba, «***».
 */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local[0]}***@${domain ? `${domain[0]}***` : '***'}${tld}`;
}

/** Cualquier dirección dentro de un texto (la respuesta de Resend puede repetirla), enmascarada. */
function maskEmailsIn(text: string): string {
  return text.replace(/[^\s"'<>@,;:()[\]]+@[^\s"'<>@,;:()[\]]+/g, (m) => maskEmail(m));
}

/**
 * Email abstraction. Inyectable como token EmailService.
 *
 * - Si `RESEND_API_KEY` está set → usa la API HTTP de Resend (sin SDK,
 *   solo fetch para no añadir dependencia más), 10 s como mucho.
 * - La dirección va enmascarada en el registro (maskEmail): nunca entera.
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
    this.fromAddress = config.get<string>('EMAIL_FROM') ?? `${BRAND_NAME} <noreply@paytomaxx.com>`;
  }

  isEnabled(): boolean {
    return Boolean(this.apiKey);
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (!this.apiKey) {
      this.logger.log(`[NoOp] Email skipped to=${maskEmail(input.to)} subject="${input.subject}"`);
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
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });

      if (!res.ok) {
        const body = await res.text();
        this.logger.warn(
          `Resend send failed status=${res.status} body=${maskEmailsIn(body.slice(0, 200))} to=${maskEmail(input.to)}`,
        );
        return { ok: false, delivered: false, reason: `resend-${res.status}` };
      }

      this.logger.log(`Email sent via Resend to=${maskEmail(input.to)} subject="${input.subject}"`);
      return { ok: true, delivered: true };
    } catch (err) {
      // Logueamos stack completo (no solo .message) para diagnosticar failures
      // de red, DNS, certificados, etc. en producción.
      const errorObj = err instanceof Error ? err : new Error(String(err));
      this.logger.error(
        `Resend send error to=${maskEmail(input.to)}: ${maskEmailsIn(errorObj.message)}`,
        errorObj.stack ? maskEmailsIn(errorObj.stack) : undefined,
      );
      return { ok: false, delivered: false, reason: 'exception' };
    }
  }
}
