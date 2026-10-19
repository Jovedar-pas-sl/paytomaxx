import { RequestMethod } from '@nestjs/common';

export interface UnprefixedRoute {
  path: string;
  method: RequestMethod;
}

/**
 * Páginas y acciones del cliente FUERA del prefijo /v1 (main.ts): el QR y los
 * enlaces apuntan a https://api.dominio.com/pay/{token}, /w/{token} y
 * /s/{token}, limpios. Nest 11 compara cada ruta con estas de forma exacta
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
  // Saldo: página del cliente y sus acciones.
  { path: 'w/:token', method: RequestMethod.GET },
  { path: 'w/:token/state', method: RequestMethod.GET },
  { path: 'w/:token/close', method: RequestMethod.POST },
  { path: 'w/:token/passkey/options', method: RequestMethod.POST },
  { path: 'w/:token/passkey', method: RequestMethod.POST },
  // PIN y sumar a otro saldo: acciones secundarias de la página del saldo.
  { path: 'w/:token/pin', method: RequestMethod.POST },
  { path: 'w/:token/merge/challenge', method: RequestMethod.POST },
  { path: 'w/:token/merge', method: RequestMethod.POST },
  // «Recargar» desde la página del saldo (con su Face ID si lo tiene).
  { path: 'w/:token/topup/challenge', method: RequestMethod.POST },
  { path: 'w/:token/topup', method: RequestMethod.POST },
  // Google Wallet: guardar el saldo (Android) y el botón oficial.
  { path: 'w/:token/google-wallet', method: RequestMethod.POST },
  { path: 'w/assets/google-wallet/:lang', method: RequestMethod.GET },
]);
