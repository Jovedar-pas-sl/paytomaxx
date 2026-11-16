/**
 * Fichas NFC del saldo (NTAG213/215/216) con Web NFC: solo Android con Chrome.
 * En iPhone una web no puede leer NFC: el propio iPhone abre el enlace grabado
 * en la ficha (sale un aviso arriba) y la app sigue desde ahí (?ficha=…).
 */
import { normalizeWalletCardUid, walletCardTokenFromUrl } from '@nightpay/contracts';
import { createNfcHub, type NdefReaderCtor, type NdefReadingEvent, type NdefRecordLike, type NfcHub } from './nfc-hub';

const UNSUPPORTED = 'Este móvil no lee fichas desde la app: en iPhone, acerca la ficha y toca el aviso';

function readerCtor(): NdefReaderCtor | null {
  if (typeof window === 'undefined') return null;
  const ctor = (window as unknown as { NDEFReader?: NdefReaderCtor }).NDEFReader;
  return typeof ctor === 'function' ? ctor : null;
}

/** ¿La app puede leer fichas aquí? (Android con Chrome). */
export function nfcSupported(): boolean {
  return readerCtor() !== null;
}

let shared: { Reader: NdefReaderCtor; hub: NfcHub } | null = null;

/** La escucha NFC de toda la app (null: aquí no hay Web NFC). Una sola, la misma para todas las pantallas. */
export function nfcHub(): NfcHub | null {
  const Reader = readerCtor();
  if (!Reader) return null;
  if (shared?.Reader !== Reader) {
    shared?.hub.stop();
    shared = {
      Reader,
      hub: createNfcHub({
        Reader,
        doc: typeof document === 'undefined' ? null : document,
        permissions: typeof navigator === 'undefined' ? null : (navigator.permissions ?? null),
      }),
    };
  }
  return shared.hub;
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

/**
 * Espera a que acerquen una ficha y la lee. Cancelar con `signal` deja de
 * esperarla, pero la escucha de la app sigue (nfc-hub): Android no abre el
 * enlace de la ficha que se queda pegada al aparato.
 */
export async function readCard(signal: AbortSignal): Promise<CardRead> {
  const hub = nfcHub();
  if (!hub) throw new Error(UNSUPPORTED);
  const tag = tagOf(await hub.next(signal));
  // Lecturas que llegan después de grabar (para comprobar qué ficha se grabó).
  let afterWrite: TagRead[] | null = null;
  let wake: (() => void) | null = null;
  let unfollow: (() => void) | null = null;
  const stopFollowing = () => {
    unfollow?.();
    unfollow = null;
  };
  signal.addEventListener('abort', stopFollowing, { once: true });

  function nextRead(timeoutMs: number): Promise<TagRead | null> {
    return new Promise((done) => {
      const finish = (read: TagRead | null) => {
        clearTimeout(timer);
        wake = null;
        stopFollowing();
        done(read);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      const take = () => {
        const read = afterWrite?.shift();
        if (read) finish(read);
      };
      wake = take;
      take();
    });
  }

  return {
    ...tag,
    writeUrl: async (link) => {
      stopFollowing();
      const queue: TagRead[] = [];
      afterWrite = queue;
      unfollow = hub.follow((event) => {
        queue.push(tagOf(event));
        wake?.();
      });
      try {
        await hub.write({ records: [{ recordType: 'url', data: link }] }, { signal, overwrite: false });
      } catch (err) {
        stopFollowing();
        throw err;
      }
    },
    nextRead,
  };
}

function urlOf(records: NdefRecordLike[]): string | null {
  for (const r of records) {
    if ((r.recordType === 'url' || r.recordType === 'absolute-url') && r.data) {
      return new TextDecoder().decode(r.data);
    }
  }
  return null;
}
