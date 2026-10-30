import { createPoller, type PollOutcome } from './poller';

/**
 * Un cobro del saldo al momento (H-2). Antes la pantalla preguntaba al API
 * por el cobro cada 1–1,5 s mientras esperaba; ahora:
 *  - se apunta a SU cobro por el tiempo real (`wallet-charge:subscribe`, con
 *    la sesión de quien cobra) y, cuando llega `wallet-charge:update` de ese
 *    cobro (pagado, cancelado, caducado, pagado con tarjeta…), pregunta ya;
 *  - al conectar (y al reconectar) pregunta una vez: lo que pasó sin conexión
 *    no se pierde; al caerse el tiempo real, también;
 *  - de respaldo, cada WALLET_CHARGE_POLL_LIVE_MS con el tiempo real y cada
 *    WALLET_CHARGE_POLL_OFFLINE_MS sin él (wifi del local, servidor
 *    reiniciando); con la pantalla oculta, nada hasta poke().
 * Lo usa useWalletChargeLive (Esperando, la pantalla de cobrar de Inicio).
 */

/** Con el tiempo real conectado, el sondeo es solo una red de seguridad. */
export const WALLET_CHARGE_POLL_LIVE_MS = 10_000;
/** Sin tiempo real, se pregunta a menudo. */
export const WALLET_CHARGE_POLL_OFFLINE_MS = 4_000;
/** El servidor cerró o rechazó la conexión (p. ej. token caducado): socket.io no reintenta solo. */
export const WALLET_CHARGE_RECONNECT_MS = 10_000;
/** Plazo de cada consulta: una colgada no deja de vigilar el cobro. */
const POLL_TIMEOUT_MS = 10_000;

/** Lo que se usa del socket de socket.io-client. */
export interface ChargeSocket {
  on(event: 'connect' | 'disconnect' | 'connect_error', listener: () => void): unknown;
  on(event: 'wallet-charge:update', listener: (e: { id?: string; status?: string }) => void): unknown;
  emit(event: 'wallet-charge:subscribe', data: { chargeId: string }): unknown;
  connect(): unknown;
  disconnect(): unknown;
  /** socket.io reconectará solo (false: el servidor la cerró). */
  readonly active: boolean;
}

export interface WalletChargeLiveOptions {
  chargeId: string;
  /** Abre el socket (lo crea al empezar). */
  socket: () => ChargeSocket;
  /** Una consulta del cobro (la de siempre): 'stop' cuando ya no está pendiente. */
  poll: (signal: AbortSignal) => Promise<PollOutcome>;
  isHidden?: () => boolean;
  /** Pausa tras una consulta fallida (servidor caído, 429). */
  slowIntervalMs?: number;
}

export interface WalletChargeLive {
  /** Primera consulta de respaldo tras `firstCheckMs` (el socket pregunta antes al conectar). */
  start(firstCheckMs?: number): void;
  stop(): void;
  /** Una consulta ya. */
  poke(): void;
  /** El tiempo real está conectado. */
  readonly live: boolean;
}

export function createWalletChargeLive(o: WalletChargeLiveOptions): WalletChargeLive {
  let live = false;
  let closed = false;
  let socket: ChargeSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const chargeId = o.chargeId.toLowerCase();

  const poller = createPoller({
    task: (signal) => o.poll(signal),
    intervalMs: () => (live ? WALLET_CHARGE_POLL_LIVE_MS : WALLET_CHARGE_POLL_OFFLINE_MS),
    slowIntervalMs: o.slowIntervalMs,
    timeoutMs: POLL_TIMEOUT_MS,
    isHidden: o.isHidden,
  });

  const goOffline = () => {
    if (closed) return;
    const wasLive = live;
    live = false;
    // Se acaba de caer: un aviso pudo perderse justo ahora; se pregunta ya.
    if (wasLive) poller.poke();
    if (socket && !socket.active && retry === null) {
      retry = setTimeout(() => {
        retry = null;
        if (!closed) socket?.connect();
      }, WALLET_CHARGE_RECONNECT_MS);
    }
  };

  return {
    start(firstCheckMs = WALLET_CHARGE_POLL_OFFLINE_MS) {
      closed = false;
      const s = o.socket();
      socket = s;
      s.on('connect', () => {
        if (closed) return;
        live = true;
        s.emit('wallet-charge:subscribe', { chargeId });
        poller.poke();
      });
      s.on('disconnect', goOffline);
      s.on('connect_error', goOffline);
      s.on('wallet-charge:update', (e) => {
        if (!closed && typeof e?.id === 'string' && e.id.toLowerCase() === chargeId) poller.poke();
      });
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
    get live() {
      return live;
    },
  };
}
