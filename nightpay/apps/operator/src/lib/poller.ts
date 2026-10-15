/**
 * Sondeo para las pantallas que se refrescan solas. La siguiente vuelta se
 * programa cuando acaba la anterior: nunca dos peticiones a la vez aunque la
 * red vaya lenta (con setInterval se amontonaban). Con la pantalla oculta no
 * se pregunta; poke() pregunta ya (al volver, al reconectar…). Una vuelta
 * que no termina (fetch sin respuesta en el wifi del local) se da por fallida
 * al plazo y se cancela: el sondeo nunca se queda congelado esperándola.
 */

/** Plazo de una vuelta por defecto. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** void: seguir · 'slow': falló (servidor caído, 429), esperar más · 'stop': no seguir. */
export type PollOutcome = void | 'stop' | 'slow';

export interface PollerOptions {
  /** Una vuelta. `signal` se cancela si pasa el plazo (pásalo a la petición). */
  task: (signal: AbortSignal) => Promise<PollOutcome>;
  /** Pausa entre el final de una vuelta y la siguiente (se lee en cada vuelta). */
  intervalMs: number | (() => number);
  /** Pausa tras una vuelta 'slow' o que lanzó. Por defecto, el triple. */
  slowIntervalMs?: number;
  /** ¿Pantalla oculta (otra app, móvil bloqueado)? Entonces se para hasta poke(). */
  isHidden?: () => boolean;
  /** Plazo de cada vuelta: pasado, cuenta como 'slow' y se cancela. Por defecto, 15 s. */
  timeoutMs?: number;
}

export interface Poller {
  /** Primera vuelta tras `delayMs` (0: ya). */
  start(delayMs?: number): void;
  stop(): void;
  /** Una vuelta ya; si hay una en marcha, otra justo al acabar. */
  poke(): void;
}

export function createPoller({
  task,
  intervalMs,
  slowIntervalMs,
  isHidden = () => false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: PollerOptions): Poller {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  let running = false;
  let again = false;

  function pause(outcome: PollOutcome): number {
    const base = typeof intervalMs === 'function' ? intervalMs() : intervalMs;
    return outcome === 'slow' ? (slowIntervalMs ?? base * 3) : base;
  }

  function clear(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function schedule(ms: number): void {
    clear();
    if (active) timer = setTimeout(() => void tick(), ms);
  }

  async function run(): Promise<PollOutcome> {
    running = true;
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<PollOutcome>((resolve) => {
      deadline = setTimeout(() => {
        controller.abort();
        resolve('slow');
      }, timeoutMs);
    });
    // Con su catch: la vuelta abandonada puede fallar después sin quedar suelta.
    const work = task(controller.signal).catch((): PollOutcome => 'slow');
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(deadline);
      running = false;
    }
  }

  async function tick(): Promise<void> {
    timer = null;
    if (!active || running) return;
    // Oculta: sin vuelta ni programación; poke() la retoma al volver a verse.
    if (isHidden()) return;
    const outcome = await run();
    if (outcome === 'stop') {
      active = false;
      return;
    }
    if (again) {
      again = false;
      schedule(0);
      return;
    }
    schedule(pause(outcome));
  }

  return {
    start(delayMs = 0) {
      active = true;
      again = false;
      schedule(delayMs);
    },
    stop() {
      active = false;
      again = false;
      clear();
    },
    poke() {
      if (!active) return;
      if (running) {
        again = true;
        return;
      }
      schedule(0);
    },
  };
}
