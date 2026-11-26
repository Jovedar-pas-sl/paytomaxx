// La ficha NFC de la compañera (cobro por el encargado, fase 2): se graba
// desde su hoja del panel, abierta en un Android con Chrome (Web NFC), como las
// de los clientes: el mismo enlace con un código nuevo. Solo en una ficha en
// blanco (nunca encima de la de un cliente) y con su número de serie, que es lo
// que hace que una copia no valga. Funciones puras con el lector inyectado
// (staff-card-nfc.test.ts).

import { STAFF_CARD_NOT_BLANK_MESSAGE, normalizeWalletCardUid, walletCardUrl } from '@nightpay/contracts';

interface NdefRecordLike {
  recordType: string;
}
interface NdefReadingEventLike {
  serialNumber?: string;
  message?: { records: NdefRecordLike[] };
}
export interface NdefWriterLike {
  scan(options?: { signal?: AbortSignal }): Promise<void>;
  write(message: { records: Array<{ recordType: string; data: string }> }, options?: { signal?: AbortSignal; overwrite?: boolean }): Promise<void>;
  onreading: ((event: NdefReadingEventLike) => void) | null;
  onreadingerror: ((event: unknown) => void) | null;
}
export type NdefWriterCtor = new () => NdefWriterLike;

export const NO_WEB_NFC = 'Para darle su ficha, abre su hoja en un Android con Chrome y acerca una ficha en blanco.';
const UNREADABLE = 'No se ha podido leer la ficha: acércala otra vez y déjala quieta un segundo.';
const NO_UID = 'No se ha podido leer el número de serie de la ficha: acércala otra vez.';

/** El lector NFC del navegador (solo Android con Chrome); null si no hay. */
export function webNfcWriter(): NdefWriterCtor | null {
  if (typeof window === 'undefined') return null;
  const ctor = (window as unknown as { NDEFReader?: NdefWriterCtor }).NDEFReader;
  return typeof ctor === 'function' ? ctor : null;
}

/** Código nuevo de 128 bits (base64url, 22 caracteres): el mismo formato que las fichas de los clientes. */
export function newStaffCardToken(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(16));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Espera una ficha, comprueba que está en blanco y le graba su enlace (sin
 * pisar nada: overwrite false). Devuelve el código grabado y su número de serie.
 */
export async function writeStaffCard(
  Reader: NdefWriterCtor,
  appOrigin: string,
  signal: AbortSignal,
  newToken: () => string = () => newStaffCardToken(),
): Promise<{ card: string; uid: string }> {
  const reader = new Reader();
  const event = await new Promise<NdefReadingEventLike>((resolve, reject) => {
    reader.onreading = resolve;
    reader.onreadingerror = () => reject(new Error(UNREADABLE));
    signal.addEventListener('abort', () => reject(new DOMException('Cancelado', 'AbortError')), { once: true });
    reader.scan({ signal }).catch(reject);
  });
  reader.onreading = null;
  reader.onreadingerror = null;
  const uid = normalizeWalletCardUid(event.serialNumber ?? '');
  if (!uid) throw new Error(NO_UID);
  const records = event.message?.records ?? [];
  if (!records.every((r) => r.recordType === 'empty')) throw new Error(STAFF_CARD_NOT_BLANK_MESSAGE);
  const card = newToken();
  await reader.write({ records: [{ recordType: 'url', data: walletCardUrl(appOrigin, card) }] }, { signal, overwrite: false });
  return { card, uid };
}
