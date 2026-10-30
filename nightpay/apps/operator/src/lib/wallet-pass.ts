// El pase de Google Wallet del cliente leído con el móvil de la chica. Su QR
// (/c/<token>) es solo para cobrar con el PIN: la cámara del móvil abre la app
// con ?pase=<token> y aquí se paga el cobro que la chica tenía abierto en
// Inicio (como la ficha en iPhone con ?ficha=); con la cámara de la app, en
// «Sin móvil ni ficha» de Esperando. Lógica pura (wallet-pass.test.ts).

import type { WalletPassCheck } from './api';

/** Por qué este pase no puede pagar aquí con su PIN (null: que lo teclee). */
export function passCheckProblem(check: WalletPassCheck): string | null {
  if (check.pinLocked) return 'Su PIN está bloqueado por fallos: avisa al encargado.';
  if (!check.hasPin) return 'Este cliente aún no tiene PIN: que pague con el QR desde su móvil, o que lo elija con el encargado.';
  if (check.ownPin) return 'Este PIN lo pusiste tú (o quien hizo el cobro): el cobro lo tiene que hacer otra persona.';
  if (!check.enough) return 'No le llega el saldo para este cobro.';
  return null;
}

/** Lo que se dice si se abre el pase sin un cobro abierto en Inicio. */
export const PASS_WITHOUT_CHARGE_TEXT =
  'Es el pase de saldo de un cliente. Para cobrarle: haz el cobro en Inicio y, con el QR en pantalla, vuelve a escanear su pase con la cámara.';

/** Lo que ve quien abre el QR del pase sin sesión (el propio cliente). */
export const PASS_OPENED_LOGGED_OUT_TEXT = 'Este es el QR de tu pase de saldo. Para pagar, enséñaselo a quien te cobra.';
