import { createPoller, type PollOutcome } from './poller';

/**
 * Conexión en directo de un cobro para las apps del personal (operadora y
 * TPV): tiempo real (socket) y, de respaldo, un sondeo. Aquí vive todo lo que
 * decide CUÁNDO se pregunta al API, para que el «PAGADO» salga pronto aunque
 * el móvil pierda cobertura:
 *  - al conectar, al confirmar el servidor la suscripción, al caerse el
 *    socket, al volver la red (evento 'online') y al volver a verse la
 *    pantalla, se pregunta ya;
 *  - de respaldo, cada PAYMENT_POLL_LIVE_MS con el tiempo real y cada
 *    PAYMENT_POLL_OFFLINE_MS sin él; mientras el cliente está en su banco
 *    (AUTHORIZING), cada PAYMENT_POLL_AUTHORIZING_MS aunque haya tiempo real;
 *    tras un fallo, igual de a menudo (antes se triplicaba la espera);
 *  - si el servidor cierra la conexión a propósito (un despliegue) se
 *    reconecta casi ya, no a los 10 s.
 */

/** Con el tiempo real conectado, el sondeo es solo una red de seguridad. */
export const PAYMENT_POLL_LIVE_MS = 10_000;
/** Sin tiempo real (wifi del local, servidor reiniciando), se pregunta a menudo. */
export const PAYMENT_POLL_OFFLINE_MS = 4_000;
/**
 * El cliente está en su banco (AUTHORIZING): el «Pagado» puede llegar en
 * cualquier momento y, si el socket se cayó sin avisar, se vería tarde.
 */
export const PAYMENT_POLL_AUTHORIZING_MS = 4_000;
/** Plazo de cada consulta: una colgada (sin cobertura) no frena la siguiente. */
export const PAYMENT_POLL_TIMEOUT_MS = 6_000;
/** El servidor rechazó la conexión (p. ej. token caducado): socket.io no reintenta solo. */
export const PAYMENT_RECONNECT_MS = 10_000;
/** El servidor cerró la conexión a propósito (despliegue): la nueva réplica ya está. */
export const PAYMENT_RECONNECT_AFTER_SERVER_CLOSE_MS = 1_000;

/** Motivo de `disconnect` con el que socket.io avisa de que el servidor cerró la conexión. */
const SERVER_CLOSED_REASON = 'io server disconnect';

/** Lo que se usa del socket de socket.io-client. */
export interface PaymentSocket {
  on(event: 'connect' | 'connect_error', listener: () => void): unknown;
  on(event: 'disconnect', listener: (reason?: string) => void): unknown;
  emit(event: 'payment:subscribe', data: { paymentId: string }, ack: (res?: { ok?: boolean }) => void): unknown;
  connect(): unknown;
  disconnect(): unknown;
  /** socket.io reconectará solo (false: el servidor la cerró o la rechazó). */
  readonly active: boolean;
}

export interface PaymentLiveOptions {
  paymentId: string;
  /** Abre el socket (lo crea al empezar); quien lo abre engancha ahí `payment:update` y `payment:completed`. */
  socket: () => PaymentSocket;
  /** Una consulta del cobro: 'stop' cuando ya no hay nada que vigilar. */
  poll: (signal: AbortSignal) => Promise<PollOutcome>;
  isHidden?: () => boolean;
  /** ¿El cobro está en el banco del cliente (AUTHORIZING)? Entonces el respaldo pregunta más a menudo. */
  isAuthorizing?: () => boolean;
  /** El tiempo real se conectó o se cayó (para el aviso de conexión). */
  onLiveChange: (live: boolean) => void;
}

export interface PaymentLive {
  /** Primera consulta tras `firstCheckMs`. */
  start(firstCheckMs?: number): void;
  stop(): void;
  /** Una consulta ya. */
  poke(): void;
}

export function createPaymentLive(o: PaymentLiveOptions): PaymentLive {
  let live = false;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let socket: PaymentSocket | null = null;

  const poller = createPoller({
    task: (signal) => o.poll(signal),
    intervalMs: () => {
      if (!live) return PAYMENT_POLL_OFFLINE_MS;
      return o.isAuthorizing?.() ? PAYMENT_POLL_AUTHORIZING_MS : PAYMENT_POLL_LIVE_MS;
    },
    // Tras un fallo se vuelve a preguntar igual de pronto (por defecto: el triple).
    slowIntervalMs: PAYMENT_POLL_OFFLINE_MS,
    timeoutMs: PAYMENT_POLL_TIMEOUT_MS,
    isHidden: o.isHidden,
  });

  const setLive = (next: boolean) => {
    live = next;
    o.onLiveChange(next);
  };

  const goOffline = (reason?: string) => {
    if (closed) return;
    const wasLive = live;
    setLive(false);
    // Se acaba de caer: un aviso pudo perderse justo ahora; se pregunta ya.
    if (wasLive) poller.poke();
    if (socket && !socket.active && retry === null) {
      const wait = reason === SERVER_CLOSED_REASON ? PAYMENT_RECONNECT_AFTER_SERVER_CLOSE_MS : PAYMENT_RECONNECT_MS;
      retry = setTimeout(() => {
        retry = null;
        if (!closed) socket?.connect();
      }, wait);
    }
  };

  return {
    start(firstCheckMs = PAYMENT_POLL_OFFLINE_MS) {
      closed = false;
      const s = o.socket();
      socket = s;
      s.on('connect', () => {
        if (closed) return;
        setLive(true);
        s.emit('payment:subscribe', { paymentId: o.paymentId }, (res) => {
          if (closed) return;
          // Rechazada (sesión caducada, sin renovar): el aviso no llegará, así que se pregunta cada poco.
          if (res?.ok === false) setLive(false);
          // Confirmada o no: lo que pasó antes de entrar en la sala del cobro no llegó por el socket.
          poller.poke();
        });
        poller.poke();
      });
      s.on('disconnect', goOffline);
      s.on('connect_error', () => goOffline());
      poller.start(firstCheckMs);
    },
    stop() {
      closed = true;
      live = false;
      if (retry !== null) clearTimeout(retry);
      retry = null;
      poller.stop();
      socket?.disconnect();
      socket = null;
    },
    poke() {
      poller.poke();
    },
  };
}
