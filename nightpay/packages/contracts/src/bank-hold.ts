import { z } from 'zod';

/**
 * Comisión retenida de las ventas por datáfono sin prueba del banco (H-1).
 *
 * Un cobro por datáfono que confirma un camarero tecleando el código del
 * ticket (`pos.confirmed`) o que el PAX da por cobrado sin poder comprobarlo
 * con Paytef (`pos.device_unproven`) sigue cobrado (AUTHORIZED) y cuenta para
 * el local, pero la parte del personal (comisión + propina) NO se paga hasta:
 *  - que el cuadre con el banco tenga ese cobro casado (MATCHED y vigente), o
 *  - que el dueño la libere a mano, con su 2FA (nunca quien la apuntó o la
 *    confirmó).
 */

/** Eventos del cobro que dicen que el banco aún no lo ha probado. */
export const POS_UNPROVEN_EVENT_TYPES = ['pos.confirmed', 'pos.device_unproven'] as const;
/** Evento del cobro: el dueño liberó su comisión a mano. */
export const BANK_HOLD_RELEASED_EVENT = 'pos.bank_released';

/** Códigos de los errores al liberar (el panel los traduce a una frase). */
export const BANK_RELEASE_CODES = {
  /** Solo el dueño libera. */
  OWNER_ONLY: 'BANK_RELEASE_OWNER_ONLY',
  /** Quien apuntó o confirmó la venta no la libera. */
  OWN_SALE: 'BANK_RELEASE_OWN_SALE',
  /** El cobro no es una venta por datáfono retenida. */
  NOT_HELD: 'BANK_HOLD_NONE',
} as const;

/** «Liberar»: el código de la app de verificación (obligatorio) y una nota opcional. */
export const ReleaseBankHoldSchema = z.object({
  totpCode: z.string().regex(/^\d{6}$/, 'El código 2FA son 6 cifras'),
  note: z.string().trim().max(300).optional(),
});
export type ReleaseBankHoldDto = z.infer<typeof ReleaseBankHoldSchema>;

/** Cómo se dio por cobrada: tecleada por el camarero o dicha por el datáfono PAX. */
export type BankHoldVia = 'camarero' | 'datafono';

/** Por qué quien mira no puede liberarla (null: puede). */
export type BankReleaseBlock = 'not_owner' | 'own_sale' | null;

/** Una venta por datáfono retenida, con la parte de una persona. */
export interface BankHoldSale {
  paymentId: string;
  /** Referencia corta del cobro (C-0001); null en los antiguos. */
  ref: string | null;
  /** Lo que se cobró en el datáfono (importe + comisión del servicio + propina). */
  chargedCents: number;
  /** La parte de esta persona que se retiene (comisión + propina − devuelto). */
  shareCents: number;
  /** Cuándo se dio por cobrada. */
  at: string;
  via: BankHoldVia;
  /** Quién la confirmó (camarero) o el datáfono que la cobró. */
  confirmedBy: string | null;
  /** El código del ticket o el número de operación del datáfono. */
  receiptRef: string | null;
  /** null: quien mira la puede liberar. */
  releaseBlock: BankReleaseBlock;
}

/** Lo retenido de una persona: el total, cuántas ventas y la lista (las más antiguas primero). */
export interface BankHoldList {
  totalCents: number;
  count: number;
  sales: BankHoldSale[];
}

/** Cómo quedó «Liberar». */
export interface BankReleaseResult {
  paymentId: string;
  /** RELEASED: liberada ahora; ALREADY_RELEASED: ya lo estaba; MATCHED: ya cuadrada con el banco. */
  status: 'RELEASED' | 'ALREADY_RELEASED' | 'MATCHED';
}
