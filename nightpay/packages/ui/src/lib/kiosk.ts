// Pantalla completa con la salida bloqueada mientras hay sesión.
// Sin React para poder probarlo con dobles: el hook useKiosk lo envuelve.
//
// Un navegador no deja impedir del todo la salida (gesto de Android, Esc
// largo): aquí se bloquea Esc donde se puede y la pantalla completa vuelve al
// siguiente toque. El bloqueo de verdad (ni Inicio ni Recientes) lo pone la
// app Android del aparato con lockApp / unlockApp.

export interface KioskEnv {
  readonly isFullscreen: () => boolean;
  /** null: el navegador no la tiene (iPhone, Chrome < 71). */
  readonly requestFullscreen: (() => Promise<void> | void) | null;
  readonly exitFullscreen: (() => Promise<void> | void) | null;
  /** Keyboard Lock (Chrome y Edge de escritorio): Esc deja de sacar de pantalla completa. */
  readonly keyboard: { lock?: (keys: string[]) => Promise<void>; unlock?: () => void } | null;
  /** La app Android del aparato (window.NightPayPax, versión 0.4+). */
  readonly native: { lockApp?: (json: string) => void; unlockApp?: (json: string) => void } | null;
}

export interface KioskController {
  /** Al entrar y en cada toque: si se ha perdido la pantalla completa, se recupera. */
  enter(): void;
  /** Al salir de la sesión: fuera pantalla completa y bloqueo. */
  leave(): void;
}

const ignore = () => undefined;

export function createKiosk(env: KioskEnv): KioskController {
  return {
    enter() {
      try {
        // En cada toque: la app solo lo intenta una vez por sesión y repone la pantalla completa.
        env.native?.lockApp?.('{}');
      } catch {
        // App del aparato vieja o cerrándose: queda la pantalla completa del navegador.
      }
      if (!env.requestFullscreen || env.isFullscreen()) return;
      try {
        // Solo tiene efecto con la pantalla completa ya concedida.
        void Promise.resolve(env.requestFullscreen())
          .then(() => env.keyboard?.lock?.(['Escape']))
          .catch(ignore);
      } catch {
        // Sin gesto del usuario o denegada: se reintenta en el siguiente toque.
      }
    },
    leave() {
      try {
        env.native?.unlockApp?.('{}');
      } catch {
        // Sin puente: nada que soltar.
      }
      try {
        env.keyboard?.unlock?.();
        if (env.exitFullscreen && env.isFullscreen()) void Promise.resolve(env.exitFullscreen()).catch(ignore);
      } catch {
        // Ya fuera de pantalla completa.
      }
    },
  };
}
