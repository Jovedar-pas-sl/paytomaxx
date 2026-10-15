import type { PayoutMethod } from './api';

/**
 * Dirección a la que la chica cobra (cripto, IBAN, email…). Una letra mal
 * puesta manda el dinero a otro sitio: se comprueba el formato según el método
 * y, si es nueva, se pide repetirla.
 */

const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
const TRC20 = new RegExp(`^T${BASE58}{33}$`);
const SOLANA = new RegExp(`^${BASE58}{32,44}$`);
const EVM = /^0x[0-9a-fA-F]{40}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_METHODS: ReadonlySet<PayoutMethod> = new Set(['FASTERPAY_EMAIL', 'PAYQUICKER_EMAIL', 'PAYONEER_EMAIL']);

/** Lo que no cuenta: espacios alrededor (y, en el IBAN, los de dentro y las mayúsculas). */
export function normalizePayoutAddress(method: PayoutMethod | '', address: string): string {
  const trimmed = address.trim();
  return method === 'SEPA_IBAN' ? trimmed.replace(/\s+/g, '').toUpperCase() : trimmed;
}

/** Por qué no vale para este método; null si vale, está vacía o no se puede comprobar aquí. */
export function payoutAddressProblem(method: PayoutMethod | '', address: string): string | null {
  const value = normalizePayoutAddress(method, address);
  if (!value || !method) return null;
  switch (method) {
    case 'USDT_TRC20':
      return TRC20.test(value) ? null : 'Una dirección de Tron (TRC20) empieza por T y tiene 34 caracteres.';
    case 'USDT_BEP20':
    case 'USDC_POLY':
      return EVM.test(value) ? null : 'Una dirección de BSC o Polygon empieza por 0x y tiene 42 caracteres.';
    case 'USDC_SOL':
      return SOLANA.test(value) ? null : 'Una dirección de Solana tiene entre 32 y 44 letras y números.';
    case 'SEPA_IBAN':
      return isValidIban(value) ? null : 'Ese IBAN no es válido: revisa las letras y los números.';
    default:
      return EMAIL_METHODS.has(method) && !EMAIL.test(value) ? 'Pon el email de tu cuenta.' : null;
  }
}

/** IBAN: país, dígitos de control y cuenta; el resto módulo 97 tiene que dar 1. */
export function isValidIban(iban: string): boolean {
  const value = iban.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value)) return false;
  const rearranged = value.slice(4) + value.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    // A = 10 … Z = 35; cifra a cifra para no salirse de los números exactos.
    const digits = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

/** Hay que repetirla si es nueva o distinta de la guardada. */
export function needsPayoutConfirmation(method: PayoutMethod | '', address: string, saved: string | null): boolean {
  const value = normalizePayoutAddress(method, address);
  return value !== '' && value !== normalizePayoutAddress(method, saved ?? '');
}

/** Lo que impide guardar el método de cobro: dirección mal escrita o que no coincide al repetirla. */
export function payoutFormProblem(
  method: PayoutMethod | '',
  address: string,
  confirm: string,
  saved: string | null,
): string | null {
  const problem = payoutAddressProblem(method, address);
  if (problem) return problem;
  if (!needsPayoutConfirmation(method, address, saved)) return null;
  return normalizePayoutAddress(method, confirm) === normalizePayoutAddress(method, address)
    ? null
    : 'Las dos direcciones no coinciden: revísalas.';
}
