// «Cómo se pagó» en el PAGADO (Grafito 3): ficha, efectivo o tarjeta. Funciones
// puras. Solo con datos que el API ya tiene: lo que falta no se pone (ni se
// inventa), y «le das de cambio» no existe porque la app no sabe cuánto
// entregó el cliente.

import { formatMoney, type ChargeAuthMethod } from '@nightpay/contracts';
import type { OutcomeHow } from '../components/PaymentOutcome';

type Row = OutcomeHow['rows'][number];

/** «Carlos · 01:22» (lo que falte, fuera). */
export function chargedBy(who: string | null | undefined, at: Date | null | undefined): string | null {
  const time = at ? at.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' }) : null;
  const text = [who?.trim() || null, time].filter(Boolean).join(' · ');
  return text || null;
}

/** «Cobró Carlos · 01:22»; sin nombre (el TPV no sabe quién cobra), solo «Hora 01:22». */
function cobroRow(who: string | null | undefined, at: Date | null | undefined): Row[] {
  const text = chargedBy(who, at);
  if (!text) return [];
  return [{ label: who?.trim() ? 'Cobró' : 'Hora', value: text }];
}

export interface SaldoHowInput {
  /** El número impreso de la ficha con la que pagó (solo si se acercó una y la ficha lo tiene). */
  fichaNumber?: string | null;
  /** El código del saldo, tapado («K7Q-•••»). */
  codeHint?: string | null;
  paidWith?: ChargeAuthMethod | null;
  /** Lo que le queda tras pagar; null: no se sabe. */
  newBalanceCents: number | null;
  who?: string | null;
  at?: Date | null;
}

/** Pagó con su saldo: con la ficha (NFC) o con su móvil (Face ID o huella). */
export function saldoHow(i: SaldoHowInput): OutcomeHow {
  const withFicha = Boolean(i.fichaNumber) || i.paidWith === 'nfc_nopin' || i.paidWith === 'pin';
  const phone = !withFicha && i.paidWith === 'passkey';
  const title = i.fichaNumber ? `Con ficha nº ${i.fichaNumber}` : withFicha ? 'Con su ficha' : phone ? 'Con su móvil' : 'Con su saldo';
  const sub = [phone ? 'Face ID o huella' : null, i.codeHint ? `Código del saldo ${i.codeHint}` : null].filter(Boolean).join(' · ');
  const rows: Row[] = [];
  if (i.newBalanceCents !== null) rows.push({ label: 'Le quedan', value: formatMoney(i.newBalanceCents, { compact: true }), num: true });
  rows.push(...cobroRow(i.who, i.at));
  return { kind: 'ficha', title, sub: sub || null, rows };
}

export interface CardHowInput {
  /** Las 4 últimas cifras, si el banco las dio. */
  last4?: string | null;
  /** «wallet»: Apple Pay o Google Pay (el banco no dice cuál). */
  payMethod?: 'card' | 'wallet' | null;
  /** El código del cobro (el que ve el cliente en su móvil). */
  code?: string | null;
  who?: string | null;
  at?: Date | null;
}

/** Pagó con tarjeta (también Apple Pay o Google Pay). */
export function cardHow(i: CardHowInput): OutcomeHow {
  const last4 = i.last4 && /^[0-9]{4}$/.test(i.last4) ? i.last4 : null;
  const rows: Row[] = [];
  if (i.code) rows.push({ label: 'Código del cobro', value: i.code, num: true });
  rows.push(...cobroRow(i.who, i.at));
  return {
    kind: 'card',
    title: last4 ? `Con tarjeta ····${last4}` : 'Con tarjeta',
    sub: i.payMethod === 'wallet' ? 'Apple Pay o Google Pay · autorizado por el banco' : 'Autorizado por el banco',
    rows,
  };
}

export interface CashHowInput {
  who?: string | null;
  at?: Date | null;
}

/** Pagó en efectivo: va a la caja. */
export function cashHow(i: CashHowInput): OutcomeHow {
  return { kind: 'cash', title: 'En efectivo', sub: 'Mételo en la caja', rows: cobroRow(i.who, i.at) };
}
