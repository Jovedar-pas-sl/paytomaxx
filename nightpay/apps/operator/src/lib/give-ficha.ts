import { parseFichaQr, type GiveFichaDto, type GivenFicha } from '@nightpay/contracts';
import { authedFetch, parseOperatorApiError } from './api';

/**
 * Recepción: dar ficha a un saldo que aún no tiene (el que el cliente cargó
 * desde casa). Se busca el saldo (su QR o su código) con la recepción exprés
 * (POST /v1/reception/desk) y, con la ficha acercada, se une a él con la
 * prueba del cliente: la de su QR o su PIN (el encargado y el dueño, sin ella).
 */

/** El QR que enseña el saldo del cliente (su código y la prueba), o por qué no vale. */
export function readFichaQr(text: string): { code: string; proof: string } | { problem: string } {
  const qr = parseFichaQr(text);
  if (qr) return qr;
  return { problem: 'Ese QR no es el de un saldo: que abra su saldo en el móvil y te enseñe el QR de «Tu ficha en recepción».' };
}

/** «K7Q-4M2» o «k7q4m2» → «K7Q4M2» (null si no son 6 letras o números). */
export function walletCodeOf(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length === 6 ? code : null;
}

export async function giveFicha(input: GiveFichaDto): Promise<GivenFicha> {
  const res = await authedFetch('/v1/reception/fichas/saldo', { method: 'POST', body: JSON.stringify(input) });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Ficha'));
  return res.json();
}
