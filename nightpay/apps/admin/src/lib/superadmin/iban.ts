// IBAN del local (donde el banco liquida los cobros con tarjeta): se comprueba
// aquí (módulo 97) antes de pedir el 2FA, y se enseña siempre tapado.

import { isValidSettlementIban, maskIban, normalizeIban } from '@nightpay/contracts';

/** Largo de un IBAN en los países con los que más se trabaja. */
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  ES: 24,
  PT: 25,
  FR: 27,
  IT: 27,
  DE: 22,
  AD: 24,
  GB: 22,
  NL: 18,
  BE: 16,
  IE: 22,
};

/** Lo que se teclea → grupos de 4 en mayúsculas ("ES91 2100 0418 …"). */
export function formatIbanInput(raw: string): string {
  return normalizeIban(raw)
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 34)
    .replace(/(.{4})(?=.)/g, '$1 ');
}

/** Por qué no vale el IBAN; null si vale. */
export function ibanProblem(raw: string): string | null {
  const iban = normalizeIban(raw);
  if (!iban) return 'Pon el IBAN.';
  if (/[^A-Z0-9]/.test(iban)) return 'El IBAN solo lleva letras y números.';
  if (!/^[A-Z]{2}\d{2}/.test(iban)) return 'El IBAN empieza por el país y dos números (ES12…).';
  const expected = IBAN_LENGTHS[iban.slice(0, 2)];
  if (expected && iban.length !== expected) {
    return `Un IBAN de ${iban.slice(0, 2)} tiene ${expected} caracteres y este tiene ${iban.length}.`;
  }
  if (!isValidSettlementIban(iban)) {
    return 'El IBAN no es válido: revisa que esté completo (el dígito de control no cuadra).';
  }
  return null;
}

/** "ES9121000418450200051332" → "ES91 •••• •••• 1332"; sin IBAN → null. */
export function maskedIban(raw: string | null | undefined): string | null {
  return maskIban(raw);
}

/** Titular: nombre o razón social, de 2 a 160 letras. */
export function holderProblem(raw: string): string | null {
  const text = raw.trim();
  if (text.length < 2) return 'Pon el titular de la cuenta (la razón social).';
  if (text.length > 160) return 'El titular, como mucho 160 letras.';
  return null;
}
