import { z } from 'zod';
import { UuidSchema } from './common';

/**
 * «Cargar saldo antes de llegar» (apps/api/src/modules/home-topup).
 *
 * El dueño enciende en Ajustes → Formas de cobro «Cargar saldo desde casa» y
 * recibe el enlace del local, https://api…/r/<código>, y su QR. El código es
 * al azar (nunca el id del local ni nada que se pueda adivinar) y «Enlace
 * nuevo» lo cambia: el de antes da 404. Cualquiera con el enlace carga un
 * saldo nuevo de ese local (decisión del dueño: el enlace se publica en
 * Instagram, en la web o en WhatsApp) y lo paga como cualquier recarga con
 * tarjeta: Apple Pay, Google Pay o tarjeta, con la comisión del servicio de
 * las recargas si el local la tiene encendida.
 *
 *   GET   /v1/admin/venue/home-topup          → el interruptor, el enlace y su QR (dueño)
 *   PATCH /v1/admin/venue/home-topup          → encender o apagar ({ enabled })
 *   POST  /v1/admin/venue/home-topup/rotate   → «Enlace nuevo»
 *
 * Al llegar, en recepción le dan una ficha unida a ese saldo:
 *
 *   POST  /v1/reception/fichas/saldo          → dar ficha a un saldo que aún no tiene
 *
 * con el QR de su saldo (lo enseña su móvil: prueba que el saldo es suyo) o
 * con su código y su PIN (el encargado y el dueño, sin PIN, como siempre).
 */

/** Las 16 letras del código del enlace (12 bytes al azar en base64url). */
export const HOME_TOPUP_CODE_RE = /^[A-Za-z0-9_-]{16}$/;

/** /r/<código>: lo que va en el enlace y en el QR (con el origen del API delante). */
export const HOME_TOPUP_PATH_PREFIX = '/r/';

/**
 * El nombre de una carga hecha con el enlace del local en el panel (Cobros:
 * la fila y su detalle) y en el libro de cobros de la gestoría (columna
 * «Origen»). Lo decide el API (CobroRow.fromHome): la Idempotency-Key de la
 * carga no sale de él.
 */
export const HOME_TOPUP_ORIGIN_LABEL = 'Desde casa';

/** Por qué el enlace, encendido, no deja cargar ahora (lo dice el panel). */
export type HomeTopUpProblem = 'paused' | 'methods' | 'gateway' | 'terminal';

export const HOME_TOPUP_PROBLEM_TEXT: Readonly<Record<HomeTopUpProblem, string>> = {
  paused: 'El local está en pausa: el enlace no deja cargar hasta que se quite la pausa.',
  methods: 'Para que funcione, enciende arriba «QR con tarjeta, Apple Pay o Google Pay» y «Pago con saldo».',
  gateway: 'El local no tiene la pasarela de pago activa: el enlace no deja cargar hasta que la tenga.',
  terminal: 'El local no tiene ningún terminal activo: el enlace no deja cargar hasta que tenga uno.',
};

/** Lo que ve el dueño en Ajustes. */
export interface HomeTopUpSettings {
  enabled: boolean;
  /** El enlace del local (null: aún no tiene código, o el interruptor está apagado). */
  url: string | null;
  /** El QR del enlace (PNG en data URL) para descargarlo o imprimirlo; null sin enlace. */
  qrPngDataUrl: string | null;
  /** Encendido pero ahora no deja cargar (null: deja). */
  problem: HomeTopUpProblem | null;
  /** Lo que se puede cargar: euros enteros de minCents a maxCents (como «Recargar» en la página del saldo). */
  minCents: number;
  maxCents: number;
  /** % de la comisión del servicio de las recargas (null: sin comisión). */
  serviceFeeBps: number | null;
}

export const UpdateHomeTopUpSchema = z.object({ enabled: z.boolean() }).strict();
export type UpdateHomeTopUpDto = z.infer<typeof UpdateHomeTopUpSchema>;

// ─── La ficha en recepción ─────────────────────────────────────────────

/**
 * El QR de la ficha que enseña el saldo del cliente (su página, /w):
 * «NPF:K7Q4M2:<prueba>», su código y una prueba firmada por el servidor (atada
 * al saldo y a su enlace de ahora) que solo ve quien tiene el saldo en su
 * móvil. Texto, no un enlace: leído con la cámara del móvil no abre nada ni
 * queda en el historial. Solo sirve para la PRIMERA ficha del saldo.
 */
export const FICHA_QR_PROOF_RE = /^[A-Za-z0-9_-]{22}$/;

export interface FichaQr {
  code: string;
  proof: string;
}

/** El QR de la ficha leído (null si no es uno). Solo se mira el formato. */
export function parseFichaQr(raw: string): FichaQr | null {
  const m = /^NPF:([A-Z0-9]{6}):([A-Za-z0-9_-]{22})$/.exec(raw.trim());
  return m ? { code: m[1] ?? '', proof: m[2] ?? '' } : null;
}

/** Lo que lleva el QR de la ficha. */
export function fichaQrContent(code: string, proof: string): string {
  return `NPF:${code}:${proof}`;
}

/**
 * Dar ficha a un saldo que no tiene: el saldo (de la búsqueda por código o
 * por su QR), la ficha acercada y cómo prueba el cliente que el saldo es suyo
 * (la prueba de su QR o su PIN). El encargado y el dueño no necesitan ninguna.
 */
export const GiveFichaSchema = z
  .object({
    walletId: UuidSchema,
    card: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Esta ficha no es nuestra'),
    uid: z.string().trim().max(64).optional(),
    proof: z.string().regex(FICHA_QR_PROOF_RE, 'Ese QR no es el de un saldo').optional(),
    pin: z.string().regex(/^[0-9]{4}$/, 'El PIN son 4 cifras').optional(),
    /**
     * B5 (la ficha que se lee sola tras «Escanear su QR»): solo una nueva o del
     * stock, nunca la de otro saldo, aunque esté gastado (409 FICHA_NOT_FREE).
     */
    onlyStock: z.literal(true).optional(),
  })
  .strict();
export type GiveFichaDto = z.infer<typeof GiveFichaSchema>;

/** Cómo se dio: con su QR, con su PIN o lo hizo el encargado. */
export type GiveFichaVia = 'qr' | 'pin' | 'manager';

export interface GivenFicha {
  walletId: string;
  /** K7Q-4M2. */
  code: string;
  balanceCents: number;
  /** El número de la ficha que se le ha dado. */
  fichaNumber: number | null;
  printedNumber?: string | null;
  via: GiveFichaVia;
}

/**
 * «Ficha perdida» en recepción (estudio de fichas, B6): una ficha nueva para
 * un saldo que ya tenía una, con una prueba (su QR, o su código y su PIN, o el
 * número de su ficha y su PIN; el encargado, sin prueba). La vieja deja de
 * pagar en la misma operación y la nueva se cobra del saldo (Ajustes → Noche,
 * `lostFichaFeeCents`): la pantalla dice cuánto antes de confirmar y manda lo
 * que dijo (si ha cambiado, 409 LOST_FICHA_FEE_CHANGED). Sin saldo que la
 * cubra, 409 LOST_FICHA_NO_BALANCE y no se hace nada.
 */
export const ReplaceLostFichaSchema = z
  .object({
    /** El saldo (por su QR o su código); o, si no, el número impreso de la ficha perdida. */
    walletId: UuidSchema.optional(),
    printedNumber: z.string().regex(/^[0-9]{1,12}$/, 'Escribe entre 1 y 12 cifras del número impreso').optional(),
    /** La ficha nueva, acercada. */
    card: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Esta ficha no es nuestra'),
    uid: z.string().trim().max(64).optional(),
    proof: z.string().regex(FICHA_QR_PROOF_RE, 'Ese QR no es el de un saldo').optional(),
    pin: z.string().regex(/^[0-9]{4}$/, 'El PIN son 4 cifras').optional(),
    /** Lo que costaba la ficha nueva en la pantalla. */
    feeCents: z.number().int().nonnegative().max(50_00),
  })
  .strict()
  .refine((d) => (d.walletId === undefined) !== (d.printedNumber === undefined), { message: 'Busca el saldo por su QR, su código o el número de su ficha' });
export type ReplaceLostFichaDto = z.infer<typeof ReplaceLostFichaSchema>;

export interface ReplacedFicha {
  /** Lo que le queda tras pagar la ficha nueva. */
  balanceCents: number;
  /** Lo que se cobró por la ficha nueva. */
  feeCents: number;
  /** La ficha nueva. */
  fichaNumber: number | null;
  printedNumber?: string | null;
  /** Las fichas que dejaron de pagar (la perdida). */
  replacedCards: number;
  via: GiveFichaVia;
}

export const LOST_FICHA_NO_BALANCE_CODE = 'LOST_FICHA_NO_BALANCE';
export const LOST_FICHA_FEE_CHANGED_CODE = 'LOST_FICHA_FEE_CHANGED';

/** El 422 cuando falta la prueba (ni QR ni PIN): la app pide una de las dos. */
export const FICHA_PROOF_REQUIRED_CODE = 'FICHA_PROOF_REQUIRED';
