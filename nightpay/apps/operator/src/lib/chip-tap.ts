// Acercar una ficha NFC en la recepción o en «Preparar fichas»: la lee y, si
// está en blanco, le graba su enlace en el mismo gesto. En el datáfono va por
// el puente de la app (writeNfc, Android NDEF); en un Android, con Web NFC.
// Nunca se graba encima de una ficha que ya tiene algo (sería dejar a un
// cliente sin su ficha): eso lo decide la ficha, no la pantalla.

import { normalizeWalletCardUid, walletCardTokenFromUrl } from '@nightpay/contracts';
import { callReader, type BridgeResponse } from './pax-bridge';
import { readCard } from './nfc';

/** Por dónde se lee: el lector del datáfono o el NFC del móvil (Web NFC). */
export type ChipVia = 'bridge' | 'web';

export interface ChipTap {
  /** El código de la ficha: el que ya tenía o el que se le acaba de grabar (null: no es nuestra). */
  token: string | null;
  uid: string | null;
  /** Se le ha grabado su enlace ahora. */
  written: boolean;
  /** Tiene otra cosa grabada (no es nuestra y no estaba en blanco): no se toca. */
  other: boolean;
}

/** La app se rinde a los 90 s; la web espera algo más (pax-bridge, 130 s). */
export const CHIP_TIMEOUT_MS = 60_000;

const WRITE_TEXT: Record<string, string> = {
  readOnly: 'Esta ficha está protegida y no se puede grabar: apártala.',
  tooSmall: 'En esta ficha no cabe el enlace: usa una NTAG213, 215 o 216.',
  writeFailed: 'No se ha podido grabar: déjala quieta y vuelve a acercarla.',
  nfcUnavailable: 'Este datáfono no deja usar fichas desde la app (el NFC lo tiene el lector de tarjetas).',
  nfcDisabled: 'El NFC del datáfono está apagado: actívalo en sus ajustes.',
  timeout: 'No se ha acercado ninguna ficha a tiempo: vuelve a intentarlo.',
  unreadable: 'No se ha podido leer: acércala otra vez y déjala quieta un segundo.',
  deviceIsBusy: 'El datáfono está con otra operación: espera a que termine.',
  notSupported: 'Esta versión de la app del datáfono no graba fichas: pide que la actualicen.',
  noReader: 'Esto solo funciona dentro de la app OxioPay del datáfono.',
};

export function chipErrorText(error: string, message?: string): string {
  return WRITE_TEXT[error] ?? message ?? 'Error del lector de fichas.';
}

/** Fallo del lector con su código (el texto ya en castellano). */
export class ChipError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(chipErrorText(code, message));
    this.code = code;
  }
}

/** Fallos tras los que no tiene sentido seguir esperando fichas (el lector no va a poder). */
const FATAL = new Set(['nfcUnavailable', 'nfcDisabled', 'notSupported', 'noReader', 'untrusted']);

export function isFatalChipError(err: unknown): boolean {
  if (err instanceof ChipError) return FATAL.has(err.code);
  // Web NFC sin permiso (o apagado en el móvil): cada intento fallaría igual.
  const name = (err as Error | null)?.name;
  return name === 'NotAllowedError' || name === 'NotSupportedError' || name === 'NotReadableError';
}

/** Nadie acercó nada a tiempo: se sigue esperando sin avisar. */
export function isChipTimeout(err: unknown): boolean {
  return err instanceof ChipError && err.code === 'timeout';
}

/**
 * La respuesta del puente (readNfc o writeNfc) → la ficha. Cancelado →
 * AbortError; otro fallo → Error con su texto en castellano.
 */
export function tapFromBridge(r: BridgeResponse): ChipTap {
  if (!r.ok) {
    if (r.error === 'cancelled') throw new DOMException('Cancelado', 'AbortError');
    throw new ChipError(r.error, r.message);
  }
  const url = r.url ?? null;
  const token = url ? walletCardTokenFromUrl(url) : null;
  const written = r.written === true;
  return {
    token,
    uid: r.uid ? normalizeWalletCardUid(r.uid) : null,
    written,
    // Sin grabar y con algo que no es nuestro (o grabada sin poder leer el enlace).
    other: !written && token === null && (url !== null || r.written === false),
  };
}

/**
 * Espera a que acerquen una ficha. Con `blankUrl`, si está en blanco se le
 * graba ese enlace (el código lo da el servidor). En el datáfono el enlace se
 * pide antes de acercarla (la app graba en el mismo toque); en el móvil, solo
 * si sale en blanco.
 */
export async function tapChip(
  via: ChipVia,
  signal: AbortSignal,
  blankUrl?: () => Promise<string>,
): Promise<ChipTap> {
  if (via === 'web') return tapWeb(signal, blankUrl);
  const url = blankUrl ? await blankUrl() : null;
  const onAbort = () => void callReader('cancelRead');
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const r = url
      ? await callReader('writeNfc', { url, onlyIfBlank: true, timeoutMs: CHIP_TIMEOUT_MS })
      : await callReader('readNfc', { timeoutMs: CHIP_TIMEOUT_MS });
    return tapFromBridge(r);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function tapWeb(signal: AbortSignal, blankUrl?: () => Promise<string>): Promise<ChipTap> {
  const read = await readCard(signal);
  if (read.token || !read.blank || !blankUrl) {
    return { token: read.token, uid: read.uid, written: false, other: read.token === null && !read.blank };
  }
  const url = await blankUrl();
  try {
    await read.writeUrl(url);
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ChipError('writeFailed');
  }
  return { token: walletCardTokenFromUrl(url), uid: read.uid, written: true, other: false };
}
