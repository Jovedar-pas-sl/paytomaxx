// «Sin móvil ni ficha» en Esperando (lógica pura, sin pantalla): el cliente
// no saca el móvil ni lleva ficha, y paga el mismo cobro con su código
// (K7Q-4M2) o con el QR de su pase de Google Wallet, y su PIN en el móvil de
// quien cobra. Antes solo estaba en la pestaña «Saldo» («Sin móvil: NFC, pase
// o código + PIN»); ahora va en la única pantalla de cobrar.

import { passChargeTokenFromText } from '@nightpay/contracts';
import type { FichaContext } from './ficha-context';

/** El botón discreto de Esperando. */
export const SIN_MOVIL_LABEL = 'Sin móvil ni ficha';

/** Cuando no hay forma: lo cobra el encargado desde el panel. */
export const NO_BATTERY_TEXT = '¿Sin batería y sin PIN? Avisa al encargado: lo cobra desde el panel.';

/** Un QR leído que no es el del pase (otro QR, el enlace del saldo /w/…). */
export const NOT_A_PASS_TEXT = 'Ese QR no es el de un pase de saldo: escanea el QR de su pase de Google Wallet.';

/** iPhone (sin cámara que lea QR desde la app): la cámara del móvil abre la app con ?pase= y aquí pone su PIN. */
export const PASS_WITH_PHONE_CAMERA_TEXT =
  'En este móvil, escanea su pase con la cámara del móvil: se abre la app para que ponga su PIN y paga este cobro.';

/**
 * ¿Se ofrece «Sin móvil ni ficha»? Solo si el cobro se puede pagar con el
 * saldo (tiene su cobro del saldo enlazado) y el local cobra con saldo.
 */
export function showsSinMovil(p: { chargeId: string | null; wallet: boolean }): boolean {
  return p.chargeId !== null && p.wallet;
}

/**
 * La ficha NFC en un iPhone: una web no la lee, pero el propio iPhone abre el
 * enlace grabado en la ficha (?ficha=…) y esa pestaña paga ESTE cobro con su
 * PIN (el contexto de ficha que guarda Esperando). Con NFC desde la app
 * (Android), no hace falta decirlo: Esperando ya la escucha.
 */
export function iphoneFichaHint(p: { chargeId: string | null; venueNfc: boolean; webNfc: boolean }): string | null {
  if (p.chargeId === null || !p.venueNfc || p.webNfc) return null;
  return '¿Ficha NFC? En iPhone, acércala a la parte de arriba del móvil y toca el aviso: pondrá su PIN.';
}

/** El código del cliente tal como se teclea: mayúsculas, solo letras, cifras y el guion (K7Q-4M2). */
export function walletCodeInput(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 10);
}

/** ¿Ya se puede buscar? 6 caracteres sin contar el guion. */
export function walletCodeComplete(code: string): boolean {
  return code.replace(/-/g, '').length >= 6;
}

/** Por qué no puede pagar con su PIN (null: que lo teclee). */
export function pinProblemOf(w: { hasPin: boolean; pinLocked: boolean }): string | null {
  if (w.pinLocked) return 'Su PIN está bloqueado por fallos: avisa al encargado.';
  if (!w.hasPin) return 'Este cliente aún no tiene PIN: que pague con el QR desde su móvil, o que lo elija con el encargado.';
  return null;
}

/** El token del pase leído con la cámara (…/c/<token> o …?pase=<token>); null si no es un pase. */
export function scannedPassToken(raw: string): string | null {
  return passChargeTokenFromText(raw);
}

/**
 * Lo que necesita la pestaña que abre una ficha en iPhone (?ficha=…) o el
 * pase leído con la cámara del móvil (?pase=…) para pagar el cobro que se ve
 * en Esperando: su cobro del saldo, lo que paga y hasta cuándo vale.
 */
export function fichaContextOf(p: {
  userId: string;
  chargeId: string;
  totalCents: number;
  what: string | null;
  expiresAt: string;
}): FichaContext {
  return {
    userId: p.userId,
    kind: 'cobro',
    chargeId: p.chargeId,
    amountCents: p.totalCents,
    serviceName: p.what?.trim() ? p.what.trim() : null,
    expiresAt: p.expiresAt,
  };
}

/** De dónde salió el saldo del PIN: cómo se dice en la pantalla del PIN. */
export type PinVia = 'nfc' | 'code' | 'pass';

/** «2 copas · saldo K7Q-4M2» (ficha o código) o «2 copas · saldo K7Q-••• · pase». */
export function pinDetail(what: string, walletCode: string, via: PinVia): string {
  return `${what} · saldo ${walletCode}${via === 'pass' ? ' · pase' : ''}`;
}
