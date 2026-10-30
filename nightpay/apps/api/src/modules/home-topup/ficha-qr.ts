import { createHmac, timingSafeEqual } from 'node:crypto';
import * as QRCode from 'qrcode';
import { FICHA_QR_PROOF_RE, fichaQrContent } from '@nightpay/contracts';

/**
 * El QR de la ficha: la página del saldo (/w) de un saldo sin ficha lo
 * enseña y recepción lo escanea para darle una ficha unida a ese saldo
 * (ReceptionFichaService). Lleva el código del saldo y una prueba firmada con
 * el secreto del servidor, atada al saldo y a su enlace de ahora, que solo ve
 * quien tiene el saldo en su móvil: con el código solo (que ven también el
 * personal y otros) no basta, hace falta además el PIN del cliente (o el
 * encargado). Una ficha con saldo paga sin PIN los importes pequeños («Noche
 * fácil»): por eso la prueba.
 *
 * La prueba no caduca, pero solo sirve para la PRIMERA ficha del saldo
 * (después, recepción ya no da otra con ella) y deja de valer si el dueño le
 * da un enlace nuevo (relink). El cliente puede guardarla en una imagen
 * («Guardar comprobante», wallet-welcome-view.ts): por eso la imagen dice
 * «Es personal: no lo compartas».
 */

const PROOF_LENGTH = 22;

/** La prueba del saldo (22 letras de base64url, 132 bits). */
export function fichaProof(secret: string, wallet: { id: string; qrToken: string }): string {
  return createHmac('sha256', secret).update(`ficha-qr:${wallet.id}:${wallet.qrToken}`).digest('base64url').slice(0, PROOF_LENGTH);
}

/** ¿Es la prueba de este saldo con su enlace de ahora? (comparación de tiempo constante) */
export function fichaProofValid(secret: string, wallet: { id: string; qrToken: string }, proof: unknown): boolean {
  if (!secret || typeof proof !== 'string' || !FICHA_QR_PROOF_RE.test(proof)) return false;
  const want = Buffer.from(fichaProof(secret, wallet));
  const got = Buffer.from(proof);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** El QR en SVG (en la página, sin imagen aparte): tinta sobre crema, como la placa del código. */
export async function fichaQrSvg(input: {
  secret: string;
  wallet: { id: string; qrToken: string };
  /** El código del saldo sin guion (K7Q4M2). */
  code: string;
}): Promise<string> {
  const content = fichaQrContent(input.code, fichaProof(input.secret, input.wallet));
  return QRCode.toString(content, {
    type: 'svg',
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#1f2c36', light: '#efe9df' },
  });
}
