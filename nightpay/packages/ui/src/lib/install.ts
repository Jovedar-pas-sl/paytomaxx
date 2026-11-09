/**
 * Instalar la web como app (pantalla completa): qué se puede hacer en este
 * móvil. Android y Chrome avisan solos (beforeinstallprompt) y basta un botón;
 * el iPhone no avisa nunca, así que hay que decir los pasos (Compartir →
 * Añadir a pantalla de inicio). Ya instalada, no se dice nada.
 */
export type InstallPlatform = 'installed' | 'prompt' | 'ios' | 'none';

export interface InstallEnv {
  userAgent: string;
  /** display-mode: standalone, o navigator.standalone en el iPhone. */
  standalone: boolean;
  /** Chrome/Android ya ha ofrecido instalar (guardamos su evento). */
  hasPrompt: boolean;
}

export function installPlatform({ userAgent, standalone, hasPrompt }: InstallEnv): InstallPlatform {
  if (standalone) return 'installed';
  if (hasPrompt) return 'prompt';
  const ua = userAgent;
  const appleMobile = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua));
  // Solo Safari instala en el iPhone: Chrome (CriOS), Firefox (FxiOS) y los
  // navegadores de dentro de otras apps no tienen «Añadir a pantalla de inicio» igual.
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA|Instagram|FBAN|FBAV|Line|WhatsApp/.test(ua);
  return appleMobile && safari ? 'ios' : 'none';
}

/** Tras «Ahora no», no se vuelve a ofrecer en este tiempo. */
export const INSTALL_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
const KEY = 'np-install-snoozed-at';

/** ¿Lo apartó hace poco? Sin almacenamiento (modo privado), no molesta: cuenta como apartado. */
export function installSnoozed(now: number, read: () => string | null = () => localStorage.getItem(KEY)): boolean {
  try {
    const at = Number(read());
    return Number.isFinite(at) && at > 0 && now - at < INSTALL_SNOOZE_MS;
  } catch {
    return true;
  }
}

export function snoozeInstall(now: number, write: (v: string) => void = (v) => localStorage.setItem(KEY, v)): void {
  try {
    write(String(now));
  } catch {
    // Sin almacenamiento: volverá a salir la próxima vez, sin más.
  }
}
