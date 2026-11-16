import { z } from 'zod';

/**
 * «Pantalla del cliente» (tablet o móvil viejo en la barra, mirando al
 * cliente): enseña el importe y el QR del cobro que está esperando el
 * camarero, «Pagado» al pagarse y, en reposo, el nombre del local.
 *
 * Se empareja con un código corto que enseña la app del personal y la
 * tablet canjea por su credencial (`Authorization: Pantalla <credencial>`).
 * Esa credencial solo LEE el cobro activo de esa persona: sin saldo, sin
 * nombres y sin ninguna acción (no crea, no cancela, no devuelve).
 */

/** Esquema de la cabecera Authorization de la tablet. */
export const CUSTOMER_DISPLAY_AUTH_SCHEME = 'Pantalla';
/** El código para emparejar caduca a los 5 minutos. */
export const CUSTOMER_DISPLAY_CODE_TTL_MS = 5 * 60 * 1000;
/** La unión caduca sola a las 12 horas (una noche). */
export const CUSTOMER_DISPLAY_PAIRING_TTL_MS = 12 * 60 * 60 * 1000;
/** Letras del código: sin las que se confunden (0/O, 1/I/L). */
export const CUSTOMER_DISPLAY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CUSTOMER_DISPLAY_CODE_LENGTH = 6;

/** Lo que teclea la tablet («k7p 4qx», «K7P-4QX»). */
export const CustomerDisplayPairSchema = z.object({ code: z.string().trim().min(4).max(20) });
export type CustomerDisplayPairDto = z.infer<typeof CustomerDisplayPairSchema>;

/** El cobro que enseña la pantalla: el de tarjeta (su QR), el del saldo, o los dos (cobro único). */
export const CustomerDisplayCurrentSchema = z
  .object({
    paymentId: z.string().uuid().nullish(),
    chargeId: z.string().uuid().nullish(),
  })
  .refine((v) => Boolean(v.paymentId || v.chargeId), { message: 'Falta el cobro' });
export type CustomerDisplayCurrentDto = z.infer<typeof CustomerDisplayCurrentSchema>;

/** Lo que ve la persona del personal en «Pantalla del cliente». */
export interface CustomerDisplayStatus {
  paired: boolean;
  /** Hasta cuándo vale la unión (ISO), o null sin pantalla. */
  pairedUntil: string | null;
}

/** El código para la tablet («K7P-4QX») y cuándo caduca. */
export interface CustomerDisplayCode {
  code: string;
  expiresAt: string;
}

/** La tablet canjea el código: su credencial (solo se entrega una vez) y el local. */
export interface CustomerDisplayPairResult {
  token: string;
  venueName: string;
  pairedUntil: string;
}

/** Cómo terminó un cobro sin pagarse. */
export type CustomerScreenEnd = 'canceled' | 'expired' | 'failed';

interface ScreenBase {
  venueName: string;
  /** El local cobra con ficha (saldo + NFC): «Paga con tu ficha o con el QR». */
  fichas: boolean;
  pairedUntil: string;
}

/**
 * Lo que enseña la tablet. Sin datos personales: ni el saldo del cliente ni
 * quién cobra. `key` identifica el cobro (opaco) para no repetir su «Pagado».
 */
export type CustomerScreenView =
  | (ScreenBase & { state: 'idle' })
  | (ScreenBase & {
      state: 'waiting';
      key: string;
      currency: string;
      /** Lo que se paga (con ficha, o con tarjeta si no hay comisión). */
      amountCents: number;
      /** Con tarjeta, si hay «Comisión del servicio»: lo que paga la tarjeta. Null sin comisión. */
      cardAmountCents: number | null;
      /** El enlace del QR (el mismo que ve el camarero). Null: no hay QR que enseñar (datáfono). */
      qrUrl: string | null;
      /** Se puede pagar acercando la ficha al móvil del camarero. */
      ficha: boolean;
      /** El cliente ya está pagando en su móvil (su banco): sin QR, «Terminando el pago…». */
      paying: boolean;
      /** Una recarga de saldo (recepción). */
      topUp: boolean;
    })
  /** Sin importe: con tarjeta, la comisión y la propina lo cambian (el «Pagado» basta). */
  | (ScreenBase & { state: 'paid'; key: string })
  | (ScreenBase & { state: 'ended'; key: string; reason: CustomerScreenEnd });

export type CustomerScreenState = CustomerScreenView['state'];
