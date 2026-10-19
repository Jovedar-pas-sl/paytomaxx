// Varias pestañas del panel comparten la sesión (la cookie del API). Cuando
// otra pestaña sale, entra o cambia de local, esta tiene que enterarse: si no,
// sigue enseñando el local viejo mientras sus peticiones ya van al nuevo. Los
// avisos llegan por BroadcastChannel (@nightpay/api-client), no por `storage`.

import type { SessionEvent } from '@nightpay/api-client';

export type SessionChange = 'signed-out' | 'signed-in' | 'venue-changed';

/**
 * Un aviso de la sesión → qué hace la página (null = nada; la caducidad en
 * ESTA pestaña llega por SESSION_EXPIRED_EVENT).
 */
export function classifySessionEvent(event: SessionEvent): SessionChange | null {
  if (event.type === 'changed') return 'venue-changed'; // otro local u otra persona
  if (event.source !== 'other-tab') return null;
  if (event.type === 'signed-in') return 'signed-in';
  return 'signed-out'; // salió o caducó allí
}
