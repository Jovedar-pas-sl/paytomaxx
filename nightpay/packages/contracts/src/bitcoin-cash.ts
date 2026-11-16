import { z } from 'zod';
import { IdempotencyKeySchema } from './reception';

// ═══════════════════════════════════════════════════════════════════════
// Devolver en efectivo lo pagado con bitcoin (el bitcoin se queda en la
// cartera del local; el cliente recibe euros de la caja). Detrás de un
// interruptor por local (Ajustes → Bitcoin), APAGADO de fábrica.
//
//   GET  /v1/bitcoin-cash/config                    → BitcoinCashConfig
//   POST /v1/payments/:id/bitcoin-cash-refund       BitcoinCashRefundDto → BitcoinCashDone | 202
//   POST /v1/btcpay/invoices/:invoiceId/cash-return BitcoinCashRefundDto → BitcoinCashDone | 202
//   POST /v1/approvals/:id/handed                   (sin cuerpo)         → BitcoinCashDone
//
// Reglas del dueño (17-nov-2026): solo el encargado y el dueño; el dueño
// aprueba (con su 2FA) cuando pasa de su umbral contando lo ya devuelto del
// cobro, y el encargado pulsa «Entregado» al darlo; hasta 7 días desde el
// pago; siempre en euros (lo de la factura), nunca bitcoin; cada devolución
// por debajo de 1.000 €; el código del recibo del cliente, siempre. El pago
// de más no se devuelve.
// ═══════════════════════════════════════════════════════════════════════

/** Días desde el pago en los que se puede devolver en efectivo. */
export const BITCOIN_CASH_REFUND_DAYS = 7;
/** Cada devolución en efectivo, por debajo de 1.000 € (Ley 7/2012). */
export const BITCOIN_CASH_MAX_CENTS = 99_999;

/** Por qué se devuelve (una lista corta; «Otro» pide escribirlo). */
export const BITCOIN_CASH_REASONS = ['WRONG_CHARGE', 'NOT_SERVED', 'CHARGED_TWICE', 'OTHER'] as const;
export type BitcoinCashReason = (typeof BITCOIN_CASH_REASONS)[number];
export const BITCOIN_CASH_REASON_LABELS: Readonly<Record<BitcoinCashReason, string>> = {
  WRONG_CHARGE: 'Cobro equivocado',
  NOT_SERVED: 'Servicio no dado',
  CHARGED_TWICE: 'Cobrado dos veces',
  OTHER: 'Otro',
};

export const BitcoinCashRefundSchema = z
  .object({
    amountCents: z.number().int().min(1).max(BITCOIN_CASH_MAX_CENTS, 'Cada devolución en efectivo, por debajo de 1.000 €'),
    reason: z.enum(BITCOIN_CASH_REASONS),
    /** Con «Otro», qué pasó (3 letras o más). */
    note: z.string().trim().max(200).optional(),
    /** El código de la pantalla «Pagado» del cliente o el id de su recibo de BTCPay (o un trozo). */
    receiptCode: z.string().trim().min(3, 'Pon el código del recibo del cliente').max(300),
    /** 2FA de quien lo devuelve (sin 2FA, la prueba de su llave: cabecera X-Step-Up-Token). */
    totpCode: z
      .string()
      .max(20)
      .transform((s) => s.replace(/\s+/g, ''))
      .pipe(z.string().regex(/^\d{6}$/, 'El código 2FA son 6 cifras'))
      .optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict()
  .refine((b) => b.reason !== 'OTHER' || (b.note?.length ?? 0) >= 3, { message: 'Con «Otro», escribe qué pasó', path: ['note'] });
export type BitcoinCashRefundDto = z.infer<typeof BitcoinCashRefundSchema>;

/** Lo que necesita el panel para enseñar el botón (lo decide el API igual). */
export interface BitcoinCashConfig {
  /** El interruptor del local (y el del servidor). */
  enabled: boolean;
  /** Desde aquí (contando lo ya devuelto del cobro) lo aprueba el dueño; el dueño, nunca. */
  approvalAboveCents: number | null;
  days: number;
  maxCents: number;
}

/** Hecho: el dinero sale de la caja. */
export interface BitcoinCashDone {
  kind: 'done';
  /** La devolución (cobro) o la devolución del bitcoin sin cobro. */
  id: string;
  amountCents: number;
  message: string;
}

/** «Entrega 45,00 € al cliente. El bitcoin se queda en la cartera del local.» */
export function bitcoinCashDoneMessage(amountCents: number): string {
  const eur = `${(amountCents / 100).toFixed(2).replace('.', ',')} €`;
  return `Entrega ${eur} al cliente, de la caja. El bitcoin se queda en la cartera del local.`;
}

/** El motivo tal como se guarda: la etiqueta y, si la hay, la nota. */
export function bitcoinCashReasonText(reason: BitcoinCashReason, note?: string | null): string {
  const label = BITCOIN_CASH_REASON_LABELS[reason];
  const extra = note?.trim();
  return extra ? `${label}: ${extra}` : label;
}
