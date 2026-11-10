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
  /** navigator.maxTouchPoints: el Safari del iPad se anuncia como un Mac, pero el Mac no es táctil. */
  maxTouchPoints?: number;
}

/**
 * ¿Es un iPhone o un iPad (con cualquier navegador, también la app ya
 * instalada)? El Safari del iPad (iPadOS 13 o posterior) envía el user agent
 * del Mac, sin «iPad» ni «Mobile»: se reconoce por la pantalla táctil.
 */
export function isAppleMobile({ userAgent, maxTouchPoints = 0 }: Pick<InstallEnv, 'userAgent' | 'maxTouchPoints'>): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

export function installPlatform(env: InstallEnv): InstallPlatform {
  if (env.standalone) return 'installed';
  if (env.hasPrompt) return 'prompt';
  const ua = env.userAgent;
  // Solo Safari instala en el iPhone: Chrome (CriOS), Firefox (FxiOS) y los
  // navegadores de dentro de otras apps no tienen «Añadir a pantalla de inicio» igual.
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA|Instagram|FBAN|FBAV|Line|WhatsApp/.test(ua);
  return isAppleMobile(env) && safari ? 'ios' : 'none';
}

/**
 * ¿Sale el aviso de instalar de la entrada? Con el botón de Android/Chrome, o
 * con los pasos del iPhone y el iPad si ahí se ofrece (`ios`).
 */
export function installHintOffered(platform: InstallPlatform | null, ios = true): boolean {
  return platform === 'prompt' || (platform === 'ios' && ios);
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
