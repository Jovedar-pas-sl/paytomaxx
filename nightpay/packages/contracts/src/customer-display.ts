import { z } from 'zod';
import type { PinKeypadLayout } from './night-settings';
import type { TipPreset } from './customer-tip';

/**
 * «Pantalla del cliente» (tablet o móvil viejo en la barra, mirando al
 * cliente): enseña el importe y el QR del cobro que está esperando el
 * camarero, «Pagado» al pagarse y, en reposo, el nombre del local y su mensaje.
 *
 * Se empareja con un código corto que enseña la app del personal y la
 * tablet canjea por su credencial (`Authorization: Pantalla <credencial>`).
 * Esa credencial solo sirve para el cobro activo de esa persona: leerlo (sin
 * saldo ni nombres), que el cliente elija su propina y pagarlo con su ficha
 * (NFC de la tablet y su PIN, con las mismas comprobaciones que en el móvil
 * del camarero). Nunca crea, cancela ni devuelve nada.
 */

/** Esquema de la cabecera Authorization de la tablet. */
export const CUSTOMER_DISPLAY_AUTH_SCHEME = 'Pantalla';
/** El código para emparejar caduca a los 5 minutos. */
export const CUSTOMER_DISPLAY_CODE_TTL_MS = 5 * 60 * 1000;
/** La unión caduca al cerrar la noche (o en su corte de las 08:00) y nunca dura más de 12 horas. */
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

/** El cobro que ve la tablet (su `key`): lo que haga va solo a ese cobro, y solo si sigue siendo el activo. */
const ScreenKey = z.string().regex(/^[0-9a-f]{16}$/);
/** El código de la ficha y su número de serie (Web NFC), como en el móvil del personal. */
const FichaCard = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Esta ficha no es nuestra');
const FichaUid = z.string().trim().max(64).nullish();

/** La propina que eligió el cliente en la tablet (0 = «Sin propina»). */
export const CustomerDisplayTipSchema = z.object({ key: ScreenKey, tipCents: z.number().int().min(0).max(500_00) });
export type CustomerDisplayTipDto = z.infer<typeof CustomerDisplayTipSchema>;

/** La ficha acercada a la tablet: paga el cobro activo (sin PIN si se puede). */
export const CustomerDisplayFichaSchema = z.object({ key: ScreenKey, card: FichaCard, uid: FichaUid });
export type CustomerDisplayFichaDto = z.infer<typeof CustomerDisplayFichaSchema>;

/** Con su PIN (y la propina de la pantalla del PIN). */
export const CustomerDisplayPinSchema = z.object({
  key: ScreenKey,
  card: FichaCard,
  uid: FichaUid,
  pin: z.string().regex(/^[0-9]{4}$/, 'El PIN son 4 cifras'),
  tipCents: z.number().int().min(0).max(500_00).nullish(),
});
export type CustomerDisplayPinDto = z.infer<typeof CustomerDisplayPinSchema>;

/** El mensaje del reposo: una promoción o una fiesta, como mucho 120 letras por línea. */
export const DISPLAY_MESSAGE_MAX = 120;

/** Una línea: saltos, tabuladores y caracteres de control, un espacio; vacía = sin ella. */
const DisplayLine = z
  .string()
  .max(1000)
  .transform((v) => v.replace(/[\s\p{Cc}]+/gu, ' ').trim())
  .pipe(z.string().max(DISPLAY_MESSAGE_MAX, `Como mucho ${DISPLAY_MESSAGE_MAX} letras por línea`))
  .nullish();

/** Lo que enseña la tablet en reposo bajo el nombre del local (null: sin esa línea). */
export interface CustomerDisplayMessage {
  line1: string | null;
  line2: string | null;
}

/** Ajustes → Carta → «Pantalla del cliente»: el mensaje y el nombre del local (para la vista previa). */
export interface CustomerDisplayMessageSettings extends CustomerDisplayMessage {
  venueName: string;
}

/**
 * El dueño o el encargado cambian el mensaje. Vacías = sin mensaje; la
 * segunda sola pasa a ser la primera.
 */
export const UpdateDisplayMessageSchema = z
  .object({ line1: DisplayLine, line2: DisplayLine })
  .transform(({ line1, line2 }): CustomerDisplayMessage => {
    const lines = [line1, line2].filter((l): l is string => Boolean(l));
    return { line1: lines[0] ?? null, line2: lines[1] ?? null };
  });
export type UpdateDisplayMessageDto = z.input<typeof UpdateDisplayMessageSchema>;

/**
 * Lo que pasó con la ficha en la tablet. Nunca el saldo ni el código del
 * cliente: «paid», hace falta su PIN (y por qué), no tiene PIN o lo tiene bloqueado.
 */
export type CustomerDisplayFichaResult =
  | { status: 'paid' }
  | { status: 'pin'; reason: string | null }
  | { status: 'no_pin' }
  | { status: 'pin_locked' };

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

/** La propina que puede elegir el cliente en la tablet (sin nada marcado de antemano). */
export interface CustomerScreenTip {
  /** Las sugeridas del local para este importe (euros o %), las de siempre. */
  presets: TipPreset[];
  /** Como mucho (el importe, y 500 €): lo mismo que en el PIN y en /pay. */
  maxCents: number;
  /** La que eligió en la tablet (0: «Sin propina», lo de partida). */
  chosenCents: number;
  /** Va entera para quien cobra (una chica): se le dice al cliente. */
  toStaff: boolean;
}

/** Cómo terminó un cobro sin pagarse. */
export type CustomerScreenEnd = 'canceled' | 'expired' | 'failed';

interface ScreenBase {
  venueName: string;
  /** El local cobra con ficha (saldo + NFC): «Paga con tu ficha o con el QR». */
  fichas: boolean;
  /** El mensaje del local para el reposo (Ajustes → Carta → «Pantalla del cliente»). */
  message: CustomerDisplayMessage;
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
      /** Lo vendido, sin propina. */
      amountCents: number;
      /** Lo que se paga con la ficha: lo vendido + la propina elegida. */
      totalCents: number;
      /** Con tarjeta, si hay «Comisión del servicio»: lo vendido + la comisión + la propina. Null sin comisión. */
      cardAmountCents: number | null;
      /** El enlace del QR (el del camarero, con la propina elegida: ?tip=). Null: no hay QR que enseñar (datáfono). */
      qrUrl: string | null;
      /** La propina, si el local y el puesto la admiten (null: sin propinas). */
      tip: CustomerScreenTip | null;
      /** El teclado del PIN del local (Ajustes → Noche): fijo o con las cifras cambiando de sitio. */
      pinKeypad: PinKeypadLayout;
      /** Hasta este importe la ficha paga sin PIN (Ajustes → Noche): el pie de la pantalla del PIN. */
      noPinMaxCents: number;
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
