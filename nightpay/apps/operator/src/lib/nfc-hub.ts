/**
 * Una sola escucha NFC (Web NFC) para toda la app del personal.
 *
 * Mientras Chrome escucha, tiene el NFC en modo lector y Android no reparte la
 * ficha. Antes cada pantalla abría su propio scan() y lo paraba al leer o al
 * irse (al pasar a Pagado): con la ficha aún pegada al aparato, Android la
 * volvía a ver y abría el enlace que lleva grabado (en Chrome o en otra ventana
 * de la app). Aquí hay un único scan() que sigue vivo mientras la app se ve.
 * Cada lectura va a la pantalla que la espera; si nadie la espera, se la traga
 * (con un aviso corto) para que Android no la abra.
 */

export interface NdefRecordLike {
  recordType: string;
  data?: DataView;
}

export interface NdefReadingEvent extends Event {
  serialNumber: string;
  message?: { records: NdefRecordLike[] };
}

export interface NdefWriteMessage {
  records: Array<{ recordType: string; data: string }>;
}

export interface NdefReaderLike {
  scan(options?: { signal?: AbortSignal }): Promise<void>;
  write(message: NdefWriteMessage, options?: { signal?: AbortSignal; overwrite?: boolean }): Promise<void>;
  onreading: ((event: NdefReadingEvent) => void) | null;
  onreadingerror: ((event: Event) => void) | null;
}

export type NdefReaderCtor = new () => NdefReaderLike;

/** Tras usar una ficha, sus lecturas siguientes se ignoran este rato: no cobra ni hace nada dos veces. */
export const SAME_FICHA_GRACE_MS = 3_000;

/** El aviso cuando se acerca una ficha y ninguna pantalla la espera. */
export const IDLE_TAP_TEXT = 'Ahora no hace falta la ficha';

export const UNREADABLE_TEXT = 'No se ha podido leer la ficha: acércala otra vez y déjala quieta un segundo';

interface Waiter {
  resolve: (event: NdefReadingEvent) => void;
  reject: (err: unknown) => void;
}

type Follower = (event: NdefReadingEvent) => void;

interface VisibilitySource {
  visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

interface PermissionSource {
  query(descriptor: { name: string }): Promise<{ state: string }>;
}

export interface NfcHubDeps {
  Reader: NdefReaderCtor;
  /** Para parar al ocultarse y seguir al volver (null: no se mira). */
  doc?: VisibilitySource | null;
  /** Para arrancar sin gesto si el permiso NFC ya está concedido. */
  permissions?: PermissionSource | null;
  now?: () => number;
}

export interface NfcHub {
  /** La siguiente ficha que se acerque (arranca la escucha si hace falta: llamar dentro del gesto). */
  next(signal: AbortSignal): Promise<NdefReadingEvent>;
  /** Mientras dure, las lecturas van aquí primero (lo que Chrome lee tras grabar), sin tiempo de gracia. */
  follow(onRead: Follower): () => void;
  /** Graba en la ficha que esté acercada. */
  write(message: NdefWriteMessage, options: { signal: AbortSignal; overwrite: boolean }): Promise<void>;
  /** Arranca la escucha sin gesto si el permiso NFC ya está concedido. */
  startIfAllowed(): Promise<boolean>;
  /** Una ficha acercada sin ninguna pantalla esperándola (ya tragada). */
  onIdleTap(listener: () => void): () => void;
  /** ¿Escucha ahora? */
  listening(): boolean;
  /** Para del todo (pruebas, o al cambiar de lector). */
  stop(): void;
}

const abortError = () => new DOMException('Cancelado', 'AbortError');

export function createNfcHub(deps: NfcHubDeps): NfcHub {
  const now = deps.now ?? Date.now;
  const doc = deps.doc ?? null;
  const waiters = new Set<Waiter>();
  const followers: Follower[] = [];
  const idleListeners = new Set<() => void>();
  let reader: NdefReaderLike | null = null;
  let scanCtrl: AbortController | null = null;
  // Arrancada alguna vez (y sin fallar): se reanuda al volver a verse.
  let wanted = false;
  let lastUsed: { serial: string; at: number } | null = null;

  const isHidden = () => doc?.visibilityState === 'hidden';

  function takeWaiters(): Waiter[] {
    const taken = [...waiters];
    waiters.clear();
    return taken;
  }

  function failAll(err: unknown) {
    for (const w of takeWaiters()) w.reject(err);
  }

  function inGrace(serial: string): boolean {
    return serial !== '' && lastUsed !== null && lastUsed.serial === serial && now() - lastUsed.at < SAME_FICHA_GRACE_MS;
  }

  function onReading(event: NdefReadingEvent) {
    const serial = event.serialNumber ?? '';
    const follower = followers[followers.length - 1];
    if (follower) {
      lastUsed = { serial, at: now() };
      follower(event);
      return;
    }
    if (inGrace(serial)) return;
    if (waiters.size === 0) {
      for (const listener of idleListeners) listener();
      return;
    }
    lastUsed = { serial, at: now() };
    // Varias pantallas esperando a la vez: a todas, como hacía Chrome con varias escuchas.
    for (const w of takeWaiters()) w.resolve(event);
  }

  function onReadingError() {
    if (followers.length > 0 || waiters.size === 0) return;
    failAll(new Error(UNREADABLE_TEXT));
  }

  function start() {
    if (scanCtrl) return;
    wanted = true;
    const ctrl = new AbortController();
    const r = new deps.Reader();
    r.onreading = onReading;
    r.onreadingerror = onReadingError;
    scanCtrl = ctrl;
    reader = r;
    const failed = (err: unknown) => {
      // La paramos nosotros (app oculta): se reanuda al volver, sin avisar a nadie.
      if (ctrl.signal.aborted) return;
      if (scanCtrl === ctrl) scanCtrl = null;
      wanted = false;
      failAll(err);
    };
    try {
      // Sin await antes: el gesto que la arranca (si hace falta permiso) sigue valiendo.
      r.scan({ signal: ctrl.signal }).catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  function halt() {
    const ctrl = scanCtrl;
    scanCtrl = null;
    ctrl?.abort();
  }

  function onVisibility() {
    if (isHidden()) halt();
    else if (wanted) start();
  }
  doc?.addEventListener('visibilitychange', onVisibility);

  return {
    next(signal) {
      if (signal.aborted) return Promise.reject(abortError());
      return new Promise<NdefReadingEvent>((resolve, reject) => {
        const onAbort = () => {
          waiters.delete(waiter);
          reject(abortError());
        };
        const waiter: Waiter = {
          resolve: (event) => {
            signal.removeEventListener('abort', onAbort);
            resolve(event);
          },
          reject: (err) => {
            signal.removeEventListener('abort', onAbort);
            reject(err);
          },
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiters.add(waiter);
        if (isHidden()) wanted = true;
        else start();
      });
    },

    follow(onRead) {
      followers.push(onRead);
      return () => {
        const i = followers.lastIndexOf(onRead);
        if (i >= 0) followers.splice(i, 1);
      };
    },

    write(message, options) {
      const r = reader ?? new deps.Reader();
      return r.write(message, options);
    },

    async startIfAllowed() {
      if (scanCtrl) return true;
      let state: string | null = null;
      try {
        state = (await deps.permissions?.query({ name: 'nfc' }))?.state ?? null;
      } catch {
        // Sin saber el permiso no se arranca sola: lo hará el primer «Acercar» de una pantalla.
        state = null;
      }
      if (state !== 'granted') return false;
      if (isHidden()) wanted = true;
      else start();
      return true;
    },

    onIdleTap(listener) {
      idleListeners.add(listener);
      return () => idleListeners.delete(listener);
    },

    listening: () => scanCtrl !== null,

    stop() {
      wanted = false;
      halt();
      doc?.removeEventListener('visibilitychange', onVisibility);
      failAll(abortError());
    },
  };
}
