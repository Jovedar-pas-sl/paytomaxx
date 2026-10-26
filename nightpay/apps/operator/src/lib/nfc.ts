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
    options?: { signal?: AbortSignal; overwrite?: boolean },
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

/**
 * ¿«Esperando» escucha el NFC? Solo con el cobro esperando, sin el PIN
 * delante, sin un pago a medio comprobar y con su pantalla a la vista: las
 * pestañas de abajo siguen montadas (con `hidden`) y una oculta cobraría la
 * ficha que se acerca en otra (APP-03).
 */
export function waitingListensNfc(s: {
  nfcOn: boolean;
  waiting: boolean;
  pinOpen: boolean;
  checking: boolean;
  shown: boolean;
}): boolean {
  return s.nfcOn && s.waiting && !s.pinOpen && !s.checking && s.shown;
}

/** Lo leído de una ficha. */
export interface TagRead {
  /** El código grabado en la ficha (null: ficha vacía o de otra cosa). */
  token: string | null;
  /** El enlace grabado (null: no tiene ninguno). */
  url: string | null;
  /** No tiene nada grabado (se puede grabar sin borrar nada). */
  blank: boolean;
  /** Número de serie (para que una copia no valga). */
  uid: string | null;
}

export interface CardRead extends TagRead {
  /**
   * Graba el enlace en la ficha que esté acercada, solo si está en blanco
   * (overwrite: false): si ya la cambiaron por otra con algo, no la pisa.
   */
  writeUrl: (url: string) => Promise<void>;
  /**
   * La siguiente lectura de este mismo escaneo tras grabar (Chrome la vuelve a
   * leer): qué ficha tiene ahora el enlace. null si no llega a tiempo.
   */
  nextRead: (timeoutMs: number) => Promise<TagRead | null>;
}

function tagOf(event: NdefReadingEvent): TagRead {
  const records = event.message?.records ?? [];
  const url = urlOf(records);
  return {
    token: url ? walletCardTokenFromUrl(url) : null,
    url,
    blank: records.every((r) => r.recordType === 'empty'),
    uid: event.serialNumber ? normalizeWalletCardUid(event.serialNumber) : null,
  };
}

/** Espera a que acerquen una ficha y la lee. Cancelar con `signal`. */
export async function readCard(signal: AbortSignal): Promise<CardRead> {
  const Reader = readerCtor();
  if (!Reader) throw new Error(UNSUPPORTED);
  const reader = new Reader();
  await reader.scan({ signal });
  // Lecturas que llegan después de grabar (para comprobar qué ficha se grabó).
  let afterWrite: TagRead[] | null = null;
  let wake: (() => void) | null = null;

  function nextRead(timeoutMs: number): Promise<TagRead | null> {
    return new Promise((done) => {
      const finish = (tag: TagRead | null) => {
        clearTimeout(timer);
        wake = null;
        done(tag);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      const take = () => {
        const tag = afterWrite?.shift();
        if (tag) finish(tag);
      };
      wake = take;
      take();
    });
  }

  return new Promise<CardRead>((resolve, reject) => {
    let first = true;
    signal.addEventListener('abort', () => reject(new DOMException('Cancelado', 'AbortError')), { once: true });
    reader.onreadingerror = () => {
      if (first) reject(new Error(UNREADABLE));
    };
    reader.onreading = (event) => {
      const tag = tagOf(event);
      if (!first) {
        if (afterWrite) {
          afterWrite.push(tag);
          wake?.();
        }
        return;
      }
      first = false;
      resolve({
        ...tag,
        writeUrl: (link) => {
          afterWrite = [];
          return reader.write({ records: [{ recordType: 'url', data: link }] }, { signal, overwrite: false });
        },
        nextRead,
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
