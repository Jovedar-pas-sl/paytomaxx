// La ficha NFC de la compañera (cobro por el encargado, fase 2): se graba
// desde su hoja del panel, abierta en un Android con Chrome (Web NFC), como las
// de los clientes: el mismo enlace con un código que da el servidor antes de
// acercarla (ligado a ella). Solo en una ficha en blanco (nunca encima de la
// de un cliente) y con su número de serie, que es lo que hace que una copia no
// valga. Si ya lleva uno de nuestros enlaces (se grabó y se perdió la
// respuesta al darla), no se toca: se devuelve ese código y el servidor dice
// si es el de ella. Funciones puras con el lector inyectado
// (staff-card-nfc.test.ts).

import { STAFF_CARD_NOT_BLANK_MESSAGE, normalizeWalletCardUid, walletCardTokenFromUrl, walletCardUrl } from '@nightpay/contracts';

interface NdefRecordLike {
  recordType: string;
  data?: DataView | null;
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

/** El código de uno de nuestros enlaces grabado en la ficha (null si no lleva ninguno). */
function writtenCode(records: readonly NdefRecordLike[]): string | null {
  if (records.length !== 1 || records[0]!.recordType !== 'url' || !records[0]!.data) return null;
  try {
    return walletCardTokenFromUrl(new TextDecoder().decode(records[0]!.data));
  } catch {
    return null;
  }
}

/**
 * Espera una ficha y le graba su enlace con `code` (el que dio el servidor),
 * solo si está en blanco (sin pisar nada: overwrite false). Si ya lleva uno
 * de nuestros enlaces, no graba: devuelve ese código (darla otra vez tras
 * perder la respuesta). Devuelve el código y su número de serie.
 */
export async function writeStaffCard(
  Reader: NdefWriterCtor,
  appOrigin: string,
  signal: AbortSignal,
  code: string,
): Promise<{ card: string; uid: string; written: boolean }> {
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
  if (!records.every((r) => r.recordType === 'empty')) {
    const already = writtenCode(records);
    if (already) return { card: already, uid, written: false };
    throw new Error(STAFF_CARD_NOT_BLANK_MESSAGE);
  }
  await reader.write({ records: [{ recordType: 'url', data: walletCardUrl(appOrigin, code) }] }, { signal, overwrite: false });
  return { card: code, uid, written: true };
}
