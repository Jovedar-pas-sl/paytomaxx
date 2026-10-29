import { RequestMethod } from '@nestjs/common';

export interface UnprefixedRoute {
  path: string;
  method: RequestMethod;
}

/**
 * Páginas y acciones del cliente FUERA del prefijo /v1 (main.ts): el QR y los
 * enlaces apuntan a https://api.dominio.com/pay/{token}, /w/{token},
 * /s/{token} y /c/{token}, limpios. Nest 11 compara cada ruta con estas de forma exacta
 * (`w/:token` no cubre `w/:token/topup`): una acción nueva que no esté aquí
 * queda en /v1/... y la página, que la llama sin /v1, recibe un 404.
 * unprefixed-routes.http.spec.ts arranca los controladores de pay, w y s y
 * comprueba que cada ruta @Public está aquí.
 */
export const UNPREFIXED_ROUTES: readonly UnprefixedRoute[] = Object.freeze([
  // Pago con QR: la página, el POST hacia el banco, el formulario, la vuelta
  // del banco y el justificante.
  { path: 'pay/result', method: RequestMethod.GET },
  { path: 'pay/:token', method: RequestMethod.GET },
  { path: 'pay/:token', method: RequestMethod.POST },
  { path: 'pay/:token/receipt', method: RequestMethod.GET },
  { path: 'pay/:token/checkout', method: RequestMethod.GET },
  // «Comprobando el pago»: su estado en JSON (por el QR y por la vuelta del banco).
  { path: 'pay/:token/status', method: RequestMethod.GET },
  { path: 'pay/result/status', method: RequestMethod.GET },
  // La letra de la marca (Manrope) de las páginas del cliente.
  { path: 'pay/assets/manrope.woff2', method: RequestMethod.GET },
  // Recarga: el cliente activa Face ID, elige PIN o la suma a su saldo, en "Pagado".
  { path: 'pay/:token/passkey/options', method: RequestMethod.POST },
  { path: 'pay/:token/passkey', method: RequestMethod.POST },
  { path: 'pay/:token/merge/challenge', method: RequestMethod.POST },
  { path: 'pay/:token/merge', method: RequestMethod.POST },
  { path: 'pay/:token/pin', method: RequestMethod.POST },
  // Pagar con el saldo escaneando el QR de la chica (Face ID).
  { path: 's/:token', method: RequestMethod.GET },
  { path: 's/:token/challenge', method: RequestMethod.POST },
  { path: 's/:token/pay', method: RequestMethod.POST },
  { path: 's/:token/state', method: RequestMethod.GET },
  // Saldo: página del cliente y sus acciones.
  { path: 'w/:token', method: RequestMethod.GET },
  { path: 'w/:token/state', method: RequestMethod.GET },
  // «Saldo al momento»: avisos de que el saldo cambió (text/event-stream).
  { path: 'w/:token/events', method: RequestMethod.GET },
  // Consulta desde la ficha NFC y desbloqueo del enlace privado de saldo.
  { path: 'w/card/:token', method: RequestMethod.GET },
  { path: 'w/card/:token/view/challenge', method: RequestMethod.POST },
  { path: 'w/card/:token/view', method: RequestMethod.POST },
  { path: 'w/:token/view/challenge', method: RequestMethod.POST },
  { path: 'w/:token/view', method: RequestMethod.POST },
  { path: 'w/:token/close/challenge', method: RequestMethod.POST },
  { path: 'w/:token/close', method: RequestMethod.POST },
  { path: 'w/:token/passkey/options', method: RequestMethod.POST },
  { path: 'w/:token/passkey', method: RequestMethod.POST },
  // PIN y sumar a otro saldo: acciones secundarias de la página del saldo.
  { path: 'w/:token/pin/challenge', method: RequestMethod.POST },
  { path: 'w/:token/pin', method: RequestMethod.POST },
  { path: 'w/:token/merge/challenge', method: RequestMethod.POST },
  { path: 'w/:token/merge', method: RequestMethod.POST },
  // «He perdido mi NFC»: el cliente lo bloquea con su Face ID.
  { path: 'w/:token/lost-nfc/challenge', method: RequestMethod.POST },
  { path: 'w/:token/lost-nfc', method: RequestMethod.POST },
  // «Recargar» desde la página del saldo (con su Face ID si lo tiene).
  { path: 'w/:token/topup/challenge', method: RequestMethod.POST },
  { path: 'w/:token/topup', method: RequestMethod.POST },
  // Google Wallet: guardar el saldo (Android) y el botón oficial.
  { path: 'w/:token/google-wallet', method: RequestMethod.POST },
  { path: 'w/assets/google-wallet/:lang', method: RequestMethod.GET },
  // QR de activación de un solo uso (M-2): la página no gasta nada; Face ID o el
  // primer PIN lo gastan y dejan el móvil en su saldo.
  { path: 'w/a/:token', method: RequestMethod.GET },
  { path: 'w/a/:token/passkey/options', method: RequestMethod.POST },
  { path: 'w/a/:token/passkey', method: RequestMethod.POST },
  { path: 'w/a/:token/pin', method: RequestMethod.POST },
  // Salida de recepción de un saldo con Face ID: el cliente la confirma en su móvil.
  { path: 'w/salida/:token', method: RequestMethod.GET },
  { path: 'w/salida/:token/challenge', method: RequestMethod.POST },
  { path: 'w/salida/:token/confirm', method: RequestMethod.POST },
  // El QR del pase de Google Wallet (solo para cobrar): a la app del personal.
  { path: 'c/:token', method: RequestMethod.GET },
]);
