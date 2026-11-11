/**
 * Sonidos de la app: el pitido de "cobro nuevo" para el camarero y el del
 * resultado de un cobro (pagado / fallido). Un solo AudioContext para toda la
 * sesión (antes uno nuevo por aviso, que no se cerraba): iPhone no deja que
 * suene si no se crea o reanuda dentro de un toque, así que se desbloquea con
 * el primer toque en la app y se cierra al salir. El silencio (el botón de la
 * pestaña POS) vale para todos.
 */

let shared: AudioContext | null = null;

const UNLOCK_EVENTS = ['click', 'touchend', 'keydown'] as const;

function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function context(): AudioContext | null {
  if (shared) return shared;
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  try {
    shared = new Ctor();
  } catch {
    return null;
  }
  return shared;
}

function resume(ctx: AudioContext): void {
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
}

/**
 * Deja el sonido listo con el primer toque (y los siguientes, hasta que
 * suene). Devuelve cómo soltarlo: quita los oyentes y cierra el contexto.
 */
export function primeAlertSound(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const unlock = () => {
    const ctx = context();
    if (!ctx) return;
    resume(ctx);
    if (ctx.state === 'running') removeListeners();
  };
  const removeListeners = () => {
    for (const type of UNLOCK_EVENTS) window.removeEventListener(type, unlock);
  };
  for (const type of UNLOCK_EVENTS) window.addEventListener(type, unlock);
  return () => {
    removeListeners();
    if (shared) void shared.close().catch(() => undefined);
    shared = null;
  };
}

/** Dos pitidos cortos sintetizados (sin ficheros de audio). Si no se puede, nada. */
export function playAlertBeep(): void {
  play([
    { freq: 880, at: 0, duration: 0.12 },
    { freq: 1320, at: 0.15, duration: 0.18 },
  ]);
}

/**
 * Resultado de un cobro: dos notas que suben (pagado) o una grave (rechazado o
 * caducado). «warn»: algo que mirar sin estar mirando la pantalla (una ficha
 * que hay que apartar).
 */
export type OutcomeSound = 'paid' | 'failed' | 'warn' | 'ficha';

const OUTCOME_NOTES: Record<OutcomeSound, readonly Note[]> = {
  // Do6 → Sol6: se oye por encima de la música.
  paid: [
    { freq: 1047, at: 0, duration: 0.16 },
    { freq: 1568, at: 0.17, duration: 0.32 },
  ],
  // La3, más larga y con un timbre más áspero: no se confunde con la de pagado.
  failed: [{ freq: 220, at: 0, duration: 0.55, type: 'triangle', gain: 0.35 }],
  // Dos notas graves seguidas: distinta del rechazo (una sola) y de pagado.
  warn: [
    { freq: 330, at: 0, duration: 0.18, type: 'triangle', gain: 0.35 },
    { freq: 330, at: 0.26, duration: 0.18, type: 'triangle', gain: 0.35 },
  ],
  // Ficha dada (B5): tres notas cortas que bajan, distintas de pagado (dos que suben).
  ficha: [
    { freq: 1319, at: 0, duration: 0.1 },
    { freq: 1175, at: 0.12, duration: 0.1 },
    { freq: 988, at: 0.24, duration: 0.18 },
  ],
};

/** Vibración (solo Android: iPhone no la tiene en la web). */
const OUTCOME_VIBRATION: Record<OutcomeSound, number[]> = {
  paid: [60, 50, 120],
  failed: [350],
  warn: [200, 100, 200],
  ficha: [40, 40, 40, 40, 40],
};

/** Sonido y vibración al cobrar del local (Ajustes → Noche). De fábrica, los dos. */
let venueFeedback = { sound: true, vibration: true };

export function setVenueFeedback(next: { sound: boolean; vibration: boolean }): void {
  venueFeedback = { ...next };
}

/** Suena y vibra con el resultado, salvo con el silencio puesto (o lo que apagó el local). */
export function playOutcomeSound(kind: OutcomeSound): void {
  if (isAlertSoundMuted()) return;
  if (venueFeedback.sound) play(OUTCOME_NOTES[kind]);
  if (venueFeedback.vibration && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate(OUTCOME_VIBRATION[kind]);
  }
}

const MUTED_KEY = 'np-pending-pos-muted';

/** El silencio que se pone en la pestaña POS (se guarda en este móvil). */
export function isAlertSoundMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAlertSoundMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
  } catch {
    // Sin almacenamiento: vale para esta sesión (el estado de la pantalla).
  }
}

interface Note {
  freq: number;
  /** Segundos desde ya. */
  at: number;
  duration: number;
  type?: OscillatorType;
  gain?: number;
}

function play(notes: readonly Note[]): void {
  const ctx = context();
  if (!ctx) return;
  resume(ctx);
  try {
    for (const note of notes) beep(ctx, note);
  } catch {
    // Audio no disponible: queda la vibración (y la pantalla).
  }
}

function beep(ctx: AudioContext, { freq, at, duration, type = 'sine', gain: level = 0.2 }: Note): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(level, ctx.currentTime + at);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + duration);
  osc.start(ctx.currentTime + at);
  osc.stop(ctx.currentTime + at + duration);
}
