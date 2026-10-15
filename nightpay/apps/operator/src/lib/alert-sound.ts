/**
 * Pitido de "cobro nuevo" para el camarero. Un solo AudioContext para toda la
 * sesión (antes uno nuevo por aviso, que no se cerraba): iPhone no deja que
 * suene si no se crea o reanuda dentro de un toque, así que se desbloquea con
 * el primer toque en la app y se cierra al salir.
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
  const ctx = context();
  if (!ctx) return;
  resume(ctx);
  try {
    beep(ctx, 880, 0, 0.12);
    beep(ctx, 1320, 0.15, 0.18);
  } catch {
    // Audio no disponible: queda la vibración.
  }
}

function beep(ctx: AudioContext, freq: number, at: number, duration: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0.2, ctx.currentTime + at);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + duration);
  osc.start(ctx.currentTime + at);
  osc.stop(ctx.currentTime + at + duration);
}
