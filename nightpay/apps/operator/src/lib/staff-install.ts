import type { InstallPlatform } from '@nightpay/ui';

// Instalar la app del personal (decisión del dueño, Grafito 2): solo en
// Android. En el iPhone y el iPad, la app instalada guarda sus datos aparte de
// Safari, y el cobro con ficha, la invitación leída con la cámara y ?pos= abren
// Safari: ahí no está la sesión ni el cobro abierto. Así que allí no se ofrece
// (ni en la entrada ni en los menús), y a quien ya la tiene instalada se le
// dice que para eso abra OxioPay en Safari. El panel y el TPV, como estaban.

/** ¿Se ofrece «Instalar en el móvil» aquí? Solo con el aviso de Android/Chrome (un botón). */
export function offerStaffInstall(platform: InstallPlatform | null): boolean {
  return platform === 'prompt';
}

/** ¿Va el aviso de abrir Safari? Ya instalada (modo app) en un iPhone o un iPad. */
export function showSafariNotice(platform: InstallPlatform | null, apple: boolean): boolean {
  return platform === 'installed' && apple;
}

/** El aviso: corto, se cierra con «Entendido» (como las otras ayudas). */
export const SAFARI_NOTICE_TEXT = 'Para cobrar con ficha o leer una invitación con la cámara, abre OxioPay en Safari.';

/** Su clave de ayuda («np-ayuda-app-instalada»): cerrada, no vuelve en este móvil. */
export const SAFARI_NOTICE_SCREEN = 'app-instalada';
