// Direcciones de cobro de las chicas: se comprueban antes de guardar para que
// un error al teclear no mande su dinero a otra cuenta. El API vuelve a
// comprobarlas; aquí es para avisar en el momento.
import type { PayoutMethod } from './api';

/** Cripto on-chain: el pago se verifica solo contra la red. */
export const AUTO_VERIFIABLE_METHODS: readonly PayoutMethod[] = [
  'USDT_TRC20',
  'USDT_BEP20',
  'USDC_POLY',
  'USDC_SOL',
];

export function isAutoVerifiable(method: PayoutMethod | null | undefined): boolean {
  return method ? AUTO_VERIFIABLE_METHODS.includes(method) : false;
}

const TRON = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IBAN_SHAPE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
const LOOKS_LIKE_IBAN = /^[A-Z]{2}\d{2}/;

const EMAIL_METHODS: readonly PayoutMethod[] = ['FASTERPAY_EMAIL', 'PAYQUICKER_EMAIL', 'PAYONEER_EMAIL'];

function compactIban(raw: string): string {
  return raw.replace(/[\s-]+/g, '').toUpperCase();
}

/** IBAN con el dígito de control bien (ISO 13616, módulo 97). Admite espacios. */
export function isValidIban(raw: string): boolean {
  const iban = compactIban(raw);
  if (!IBAN_SHAPE.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of value) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

/** Lo que se guarda: sin espacios sobrantes; un IBAN, junto y en mayúsculas. */
export function normalizePayoutAddress(method: PayoutMethod | null, raw: string): string {
  const trimmed = raw.trim();
  if (method === 'SEPA_IBAN') return compactIban(trimmed);
  if (method === 'WIRE_INTERNATIONAL' && LOOKS_LIKE_IBAN.test(compactIban(trimmed))) {
    return compactIban(trimmed);
  }
  return trimmed;
}

/** Por qué la dirección no vale para ese método; null si vale (o no hace falta). */
export function payoutAddressError(method: PayoutMethod | null, raw: string): string | null {
  if (!method || method === 'MANUAL_CASH') return null;
  const value = normalizePayoutAddress(method, raw);
  if (!value) return 'Falta la dirección, cuenta o email para este método.';
  switch (method) {
    case 'USDT_TRC20':
      return TRON.test(value) ? null : 'Dirección Tron no válida: 34 caracteres que empiezan por T.';
    case 'USDT_BEP20':
    case 'USDC_POLY':
      return EVM.test(value) ? null : 'Dirección no válida: 0x y 40 caracteres (0-9, a-f).';
    case 'USDC_SOL':
      return SOLANA.test(value) ? null : 'Dirección Solana no válida: entre 32 y 44 caracteres.';
    case 'SEPA_IBAN':
      return isValidIban(value) ? null : 'IBAN no válido: revisa las letras y los números.';
    case 'WIRE_INTERNATIONAL':
      // IBAN (Georgia, etc.) o número de cuenta: si tiene forma de IBAN, se comprueba.
      return !LOOKS_LIKE_IBAN.test(value) || isValidIban(value)
        ? null
        : 'IBAN no válido: revisa las letras y los números.';
    default:
      if (EMAIL_METHODS.includes(method)) {
        return EMAIL.test(value) ? null : 'Email no válido.';
      }
      return null;
  }
}
