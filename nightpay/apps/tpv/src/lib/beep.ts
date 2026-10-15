// Pitido de "pagado". Un solo AudioContext para toda la página: los
// navegadores limitan cuántos se crean, y solo dejan sonar tras un gesto.

type AudioContextCtor = typeof AudioContext;

let shared: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (shared) return shared;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  const Ctor: AudioContextCtor | undefined = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  try {
    shared = new Ctor();
  } catch {
    // Sin audio (navegador o permisos): el cobro se ve igual en pantalla.
    return null;
  }
  return shared;
}

function resume(ctx: AudioContext): void {
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {
      // Sigue bloqueado hasta el próximo gesto: el pitido es un extra.
    });
  }
}

/** Llamar desde un gesto (pulsar Cobrar): deja el audio listo para el pitido posterior. */
export function unlockBeep(): void {
  const ctx = audioContext();
  if (ctx) resume(ctx);
}

export function playBeep(): void {
  const ctx = audioContext();
  if (!ctx) return;
  resume(ctx);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 880;
  osc.connect(gain);
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0.2, ctx.currentTime);
  osc.start();
  osc.stop(ctx.currentTime + 0.18);
}
