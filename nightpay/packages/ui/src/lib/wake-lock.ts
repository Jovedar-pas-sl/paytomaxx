// Pantalla encendida mientras hay un cobro abierto (Screen Wake Lock API).
// Sin React para poder probarlo con dobles: el hook useWakeLock lo envuelve.

/** Lo que se usa del WakeLockSentinel del navegador. */
export interface WakeLockSentinelLike {
  readonly released?: boolean;
  release(): Promise<void>;
}

/** Lo que se usa de navigator.wakeLock. */
export interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export interface WakeLockEnv {
  /** null: el navegador no lo tiene (iOS < 16.4, Firefox antiguo, http sin TLS…). */
  readonly wakeLock: WakeLockLike | null;
  /** El navegador solo lo concede con la página a la vista. */
  readonly isVisible: () => boolean;
}

export interface WakeLockController {
  /** Pedir la pantalla encendida (y volver a pedirla al volver a la página). */
  start(): void;
  /** Soltarla: el cobro terminó o la pantalla se fue. */
  stop(): void;
  /** Llamar en cada visibilitychange: al ocultarse el navegador la suelta solo. */
  onVisibilityChange(): void;
}

/** navigator.wakeLock si existe y se puede usar; null si no (fuera del navegador, sin soporte). */
export function wakeLockFrom(nav: unknown): WakeLockLike | null {
  if (typeof nav !== 'object' || nav === null || !('wakeLock' in nav)) return null;
  const lock = (nav as { wakeLock?: unknown }).wakeLock;
  if (typeof lock !== 'object' || lock === null) return null;
  return typeof (lock as { request?: unknown }).request === 'function' ? (lock as WakeLockLike) : null;
}

const ignore = (): void => undefined;

/** Nunca lanza: sin soporte, sin permiso o con batería baja, simplemente no hace nada. */
export function createWakeLock(env: WakeLockEnv): WakeLockController {
  let wanted = false;
  let pending = false;
  let sentinel: WakeLockSentinelLike | null = null;

  function holding(): boolean {
    return sentinel !== null && sentinel.released !== true;
  }

  async function acquire(): Promise<void> {
    const lock = env.wakeLock;
    if (!lock || !wanted || pending || holding() || !env.isVisible()) return;
    pending = true;
    try {
      const got = await lock.request('screen');
      // Se soltó mientras se pedía: no se queda encendida.
      if (wanted) sentinel = got;
      else void got.release().catch(ignore);
    } catch {
      // NotAllowedError (batería baja, página oculta…): la pantalla se apaga como siempre.
    } finally {
      pending = false;
    }
  }

  return {
    start() {
      wanted = true;
      void acquire();
    },
    stop() {
      wanted = false;
      const held = sentinel;
      sentinel = null;
      if (held && held.released !== true) void held.release().catch(ignore);
    },
    onVisibilityChange() {
      if (!wanted || !env.isVisible()) return;
      // Al ocultarse, el navegador la soltó: se pide otra.
      if (sentinel && sentinel.released !== false) sentinel = null;
      void acquire();
    },
  };
}
