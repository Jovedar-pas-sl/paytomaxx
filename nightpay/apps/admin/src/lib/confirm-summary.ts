// Frase de una línea antes de confirmar algo que mueve dinero: cuánto, a quién,
// por dónde y desde qué local, y que no se puede deshacer. Las direcciones,
// IBAN y emails van enmascarados por el medio.

import { formatEur } from './money';

const ELLIPSIS = '…';
const IRREVERSIBLE = 'No se puede deshacer.';

/** "TXYZabcd…9f2a": principio y final; lo corto se deja entero. */
export function maskMiddle(value: string, head = 4, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}${ELLIPSIS}${value.slice(-tail)}`;
}

const IBAN_LIKE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
const EMAIL = /^([^\s@]+)@([^\s@]+\.[^\s@]+)$/;

/** Dirección, IBAN, email o cuenta de cobro, sin enseñarla entera. */
export function maskPayoutTarget(raw: string): string {
  const value = raw.trim();
  const compact = value.replace(/[\s-]+/g, '').toUpperCase();
  if (IBAN_LIKE.test(compact)) return maskMiddle(compact, 4, 4);
  const email = EMAIL.exec(value);
  if (email?.[1] && email[2]) return `${email[1].slice(0, 1)}${ELLIPSIS}@${email[2]}`;
  return maskMiddle(value, 4, 4);
}

export function refundSummary(input: { amountCents: number; cardLast4: string | null; venueName: string }): string {
  const to = input.cardLast4 ? `a la tarjeta ••${input.cardLast4}` : 'al cliente de este cobro';
  return `Vas a devolver ${formatEur(input.amountCents)} ${to} desde ${input.venueName}. ${IRREVERSIBLE}`;
}

export function payoutSummary(input: {
  amountCents: number;
  operatorName: string;
  /** Nombre corto del método ("USDT TRC20"); null si aún no se ha elegido. */
  methodLabel: string | null;
  /** Dirección o cuenta guardada; null si no hay (efectivo, otro método). */
  target: string | null;
  venueName: string;
}): string {
  const via = input.methodLabel ? ` en ${input.methodLabel}` : '';
  const to = input.target ? ` a ${maskPayoutTarget(input.target)}` : '';
  return `Vas a dar por pagados ${formatEur(input.amountCents)} a ${input.operatorName}${via}${to} desde ${input.venueName}. ${IRREVERSIBLE}`;
}

export function walletPayoutSummary(input: {
  amountCents: number;
  method: 'CASH' | 'CARD';
  code: string | null;
  venueName: string;
}): string {
  const how = input.method === 'CASH' ? 'en efectivo' : 'a la tarjeta';
  const wallet = input.code ? `del saldo ${input.code}` : 'del saldo';
  return `Vas a devolver ${formatEur(input.amountCents)} ${how} ${wallet} desde ${input.venueName}. ${IRREVERSIBLE}`;
}
