/**
 * Fichas NFC del saldo (NTAG213/215/216) con Web NFC: solo Android con Chrome.
 * En iPhone una web no puede leer NFC: el propio iPhone abre el enlace grabado
 * en la ficha (sale un aviso arriba) y la app sigue desde ahí (?ficha=…).
 */
import { normalizeWalletCardUid, walletCardTokenFromUrl } from '@nightpay/contracts';

interface NdefRecordLike {
  recordType: string;
  data?: DataView;
}

interface NdefReadingEvent extends Event {
  serialNumber: string;
  message?: { records: NdefRecordLike[] };
}

interface NdefReaderLike {
  scan(options?: { signal?: AbortSignal }): Promise<void>;
  write(
    message: { records: Array<{ recordType: string; data: string }> },
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  onreading: ((event: NdefReadingEvent) => void) | null;
  onreadingerror: ((event: Event) => void) | null;
}

type NdefReaderCtor = new () => NdefReaderLike;

const UNSUPPORTED = 'Este móvil no lee fichas desde la app: en iPhone, acerca la ficha y toca el aviso';
const UNREADABLE = 'No se ha podido leer la ficha: acércala otra vez y déjala quieta un segundo';

function readerCtor(): NdefReaderCtor | null {
  if (typeof window === 'undefined') return null;
  const ctor = (window as unknown as { NDEFReader?: NdefReaderCtor }).NDEFReader;
  return typeof ctor === 'function' ? ctor : null;
}

/** ¿La app puede leer fichas aquí? (Android con Chrome). */
export function nfcSupported(): boolean {
  return readerCtor() !== null;
}

export interface CardRead {
  /** El código grabado en la ficha (null: ficha vacía o de otra cosa). */
  token: string | null;
  /** Número de serie (para que una copia no valga). */
  uid: string | null;
  /** Graba el enlace en esta misma ficha (mientras sigue acercada). */
  writeUrl: (url: string) => Promise<void>;
}

/** Espera a que acerquen una ficha y la lee. Cancelar con `signal`. */
export async function readCard(signal: AbortSignal): Promise<CardRead> {
  const Reader = readerCtor();
  if (!Reader) throw new Error(UNSUPPORTED);
  const reader = new Reader();
  await reader.scan({ signal });
  return new Promise<CardRead>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Cancelado', 'AbortError')), { once: true });
    reader.onreadingerror = () => reject(new Error(UNREADABLE));
    reader.onreading = (event) => {
      const url = urlOf(event.message?.records ?? []);
      resolve({
        token: url ? walletCardTokenFromUrl(url) : null,
        uid: event.serialNumber ? normalizeWalletCardUid(event.serialNumber) : null,
        writeUrl: (link) => reader.write({ records: [{ recordType: 'url', data: link }] }, { signal }),
      });
    };
  });
}

function urlOf(records: NdefRecordLike[]): string | null {
  for (const r of records) {
    if ((r.recordType === 'url' || r.recordType === 'absolute-url') && r.data) {
      return new TextDecoder().decode(r.data);
    }
  }
  return null;
}
