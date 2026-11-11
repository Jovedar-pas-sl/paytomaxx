import { z } from 'zod';
import { FICHA_CHECKS, IdempotencyKeySchema, MAX_CASH_TOP_UP_CENTS, type RecentTopUp } from './reception';
import type { ChargeRights } from './post-rules';
import { staffCan, type StaffPermissions } from './venue-settings';

/**
 * Salida de recepción (maqueta 4.5): devolver el saldo en efectivo con el NFC
 * del cliente. NFC = tarjeta, ficha o pulsera: se trata igual.
 *  - El cliente lo autoriza con su PIN; si su saldo tiene Face ID, en su
 *    propio móvil (un QR que le enseña recepción), y el PIN no basta.
 *  - Más de 100 € (más de 100,00 €), o pasado el tope de la noche de quien
 *    devuelve: el encargado con su 2FA.
 *  - Lo que no sale en efectivo (entró con tarjeta) queda pendiente para el
 *    dueño «A la tarjeta».
 */

/** Cómo se autorizó una salida en efectivo de recepción (queda en la auditoría). */
export const RECEPTION_PAYOUT_AUTH_METHODS = ['nfc_pin', 'passkey', 'manager_2fa'] as const;
export type ReceptionPayoutAuth = (typeof RECEPTION_PAYOUT_AUTH_METHODS)[number];

/** Por qué una salida necesita al encargado. */
export type ReceptionPayoutReason = 'over_limit' | 'night_cap' | 'no_passkey';

/**
 * Lo que necesita una salida antes de que el cliente ponga su PIN
 * (POST /v1/reception/wallets/:id/payout/plan), para pedirlo una sola vez:
 *  - none: el NFC y el PIN del cliente (o su Face ID);
 *  - manager_2fa: quien devuelve es el encargado y pone su 2FA;
 *  - manager_pending: queda pendiente para el encargado (lo confirma en el
 *    panel con su 2FA): aún no sale dinero.
 */
export interface ReceptionPayoutPlan {
  amountCents: number;
  needs: 'none' | 'manager_2fa' | 'manager_pending';
  reasons: ReceptionPayoutReason[];
  /** El saldo tiene Face ID: el cliente confirma en su móvil (el PIN no basta). */
  passkey: boolean;
  /** Lo que esta persona ya ha devuelto en efectivo esta noche y su tope. */
  nightPaidCents: number;
  nightCapCents: number;
}

/** 403: su puesto no devuelve efectivo (de fábrica, solo Recepción). */
export const CASH_PAYOUT_RECEPTION_ONLY_CODE = 'CASH_PAYOUT_RECEPTION_ONLY';
export const CASH_PAYOUT_RECEPTION_ONLY_MESSAGE = 'El saldo se devuelve en efectivo en recepción.';

/** 409: este saldo tiene Face ID y recepción no puede devolverlo solo con el PIN. */
export const PAYOUT_PASSKEY_REQUIRED_CODE = 'PAYOUT_PASSKEY_REQUIRED';
export const PAYOUT_PASSKEY_REQUIRED_MESSAGE =
  'Este saldo tiene Face ID: el cliente confirma la salida en su móvil (el QR). Sin su móvil, lo devuelve el encargado.';

/** El QR que abre el cliente para confirmar la salida con su Face ID. */
export interface ReceptionPayoutPasskeyRequest {
  url: string;
  expiresAt: string;
}

export interface ReceptionPayoutPasskeyStatus {
  status: 'waiting' | 'confirmed' | 'expired';
}

/** Lo que dura el QR de la salida con Face ID. */
export const PAYOUT_PASSKEY_TTL_SECONDS = 300;

/**
 * ¿Puede esta persona devolver saldo en efectivo en recepción? El dueño,
 * siempre; el encargado, con «Dar efectivo»; el camarero, si su puesto lo
 * hace (de fábrica, Recepción) y el dueño no se lo ha quitado en Permisos. No
 * depende de las recargas: se puede quitar una cosa sin la otra.
 */
export function canPayOutCash(
  perms: StaffPermissions,
  person: { role: string; userId: string },
  rights: Pick<ChargeRights, 'cashPayout'>,
): boolean {
  if (person.role === 'OWNER') return true;
  if (person.role === 'MANAGER') return staffCan(perms, person, 'cash');
  if (person.role !== 'WAITER') return false;
  return rights.cashPayout && staffCan(perms, person, 'cashPayout');
}

// ─── Buscar por el número impreso (sin acercar el NFC) ───────────────────

/**
 * Lo que se ve de una ficha buscada por su número impreso: el número se lee
 * de la ficha y no prueba que la tengan delante. Nada que sirva para pagar:
 * ni el código del saldo (K7Q-•••), ni su id.
 */
export type ReceptionNumberView =
  | { kind: 'new'; printedNumber: string }
  | {
      kind: 'saldo';
      printedNumber: string;
      /** K7Q-•••: para que el cliente lo reconozca. */
      codeHint: string;
      balanceCents: number;
      cashOutCents: number;
      cashOutNote: string | null;
      hasPin: boolean;
      blocked: boolean;
      closeRequested: boolean;
      isHomeVenue: boolean;
      /** La última recarga, si es reciente (A4). */
      lastTopUp?: RecentTopUp | null;
    };

/** Una ficha nueva (o del stock) se carga acercándola: así sale con su saldo. */
export const NEW_FICHA_BY_NUMBER_MESSAGE = 'Para cargar una ficha nueva, acércala';

/** Recarga en efectivo de la ficha buscada por su número (solo saldos que ya existen). */
export const ReceptionNumberTopUpSchema = z
  .object({
    printedNumber: z.string().regex(/^[0-9]{1,12}$/, 'Escribe entre 1 y 12 cifras del número impreso'),
    amountCents: z.number().int().positive().max(MAX_CASH_TOP_UP_CENTS, 'En efectivo, como mucho 999,99 € por recarga'),
    idempotencyKey: IdempotencyKeySchema,
    /** La «Comisión del servicio» que enseñó la pantalla (como CashTopUpSchema). */
    serviceFeeCents: z.number().int().nonnegative().max(MAX_CASH_TOP_UP_CENTS).optional(),
    /** B2: confirmada acercando otra vez la ficha o «Cargar sin leerla» (como CashTopUpSchema). */
    fichaCheck: z.enum(FICHA_CHECKS).optional(),
  })
  .strict();
export type ReceptionNumberTopUpDto = z.infer<typeof ReceptionNumberTopUpSchema>;

/** Lo que devuelve: sumado, sin el código entero ni el id del saldo. */
export interface ReceptionNumberTopUpResult {
  topUpId: string;
  codeHint: string;
  amountCents: number;
  /** La «Comisión del servicio» cobrada encima (0 sin ella). Opcional: API anterior. */
  serviceFeeCents?: number;
  balanceCents: number;
  replayed: boolean;
}

/** «K7Q-4M2» o «K7Q4M2» → «K7Q-•••». */
export function maskedWalletCode(code: string): string {
  const clean = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return `${clean.slice(0, 3)}-•••`;
}
