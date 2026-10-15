// Qué le pasa a la conexión, dicho en llano (en vez de un «Reconectando…»
// que no explica nada). Puro: las señales las juntan las apps.

export type ConnectionIssueKind = 'offline' | 'server' | 'bank';

export interface ConnectionIssue {
  readonly kind: ConnectionIssueKind;
  /** Qué pasa, en una frase. */
  readonly title: string;
  /** Qué hacer mientras tanto. */
  readonly hint: string;
}

export interface ConnectionSignals {
  /** navigator.onLine: false es seguro (sin red); true no garantiza que haya internet. */
  readonly online: boolean;
  /** El API no contesta: 5xx, ServerUnavailableError o socket caído (ya con su margen). */
  readonly serverDown: boolean;
  /** Desde cuándo (ms) un cobro abierto espera al banco (AUTHORIZING); null si ninguno. */
  readonly bankWaitingSinceMs: number | null;
  /** El banco no confirmó a tiempo (ORPHAN): se resolverá luego, no al momento. */
  readonly orphan?: boolean;
}

/** Aparato en el que se enseña: cambia la frase de «sin internet». */
export type ConnectionDevice = 'phone' | 'register';

/** A partir de cuánto esperando al banco se avisa. */
export const BANK_SLOW_AFTER_MS = 20_000;

/** Lo que tiene que pasar con el socket o el API caídos antes de avisar (un corte de 1 s no asusta). */
export const SERVER_DOWN_GRACE_MS = 2_500;

const OFFLINE_TITLE: Record<ConnectionDevice, string> = {
  phone: 'Tu móvil no tiene internet',
  register: 'Este TPV no tiene internet',
};

const OFFLINE_HINT: Record<ConnectionDevice, string> = {
  phone: 'Mira el wifi o los datos. Si urge, cobra con el datáfono.',
  register: 'Mira el wifi o el cable. Si urge, cobra con el datáfono.',
};

/**
 * El problema que se enseña, el más básico primero: sin internet no se sabe
 * nada del servidor, y con el servidor caído no se sabe nada del banco.
 * null: todo bien.
 */
export function classifyConnection(
  signals: ConnectionSignals,
  nowMs: number,
  device: ConnectionDevice = 'phone',
): ConnectionIssue | null {
  if (!signals.online) {
    return { kind: 'offline', title: OFFLINE_TITLE[device], hint: OFFLINE_HINT[device] };
  }
  if (signals.serverDown) {
    return {
      kind: 'server',
      title: 'OxioPay no responde, reintentando…',
      hint: 'No hace falta recargar. Si urge, cobra con el datáfono.',
    };
  }
  const waiting = signals.bankWaitingSinceMs;
  if (signals.orphan || (waiting !== null && nowMs - waiting >= BANK_SLOW_AFTER_MS)) {
    return {
      kind: 'bank',
      title: 'El banco está tardando',
      // Cobrar otra vez aquí podría cobrarle dos veces al cliente.
      hint: 'No cobres otra vez: espera su respuesta. Si no llega, avisa al encargado.',
    };
  }
  return null;
}
