// Esperando y resultado (maqueta 3.1–3.4, 2.4–2.5): lo que se enseña de un
// cobro mientras espera el NFC o el QR, y en su PAGADO / NO PAGADO. Funciones
// puras (se prueban sin pantalla).

import {
  invitationShares,
  type ChargeAuthMethod,
  type InvitationRules,
  type VenueNightSettings,
} from '@nightpay/contracts';
import { formatEur } from './money';

/** Cómo pagó, en la línea del PAGADO («Carlos · 2 copas · NFC · 01:10»). */
export type PaidMethod = ChargeAuthMethod | 'card';

export const METHOD_LABEL: Readonly<Record<PaidMethod, string>> = {
  nfc_nopin: 'NFC',
  pin: 'NFC + PIN',
  passkey: 'Saldo en su móvil',
  staff: 'Encargado',
  card: 'Tarjeta',
};

export function methodLabel(method: PaidMethod | null | undefined): string | null {
  return method ? METHOD_LABEL[method] : null;
}

/** «Carlos · 2 copas · NFC · 01:10» (lo que falte, fuera). */
export function paidMeta(parts: { who?: string | null; what?: string | null; method?: PaidMethod | null; at: Date }): string {
  const time = parts.at.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
  return [parts.who, parts.what, methodLabel(parts.method), time].filter(Boolean).join(' · ');
}

/** ¿Pedirá el PIN si paga con el NFC? (más que el tope sin PIN del local). */
export function pinExpected(totalCents: number, night: Pick<VenueNightSettings, 'nfcNoPinMaxCents'>): boolean {
  return totalCents > night.nfcNoPinMaxCents;
}

/** «Más de 20 €: el cliente pondrá su PIN». */
export function pinWarning(night: Pick<VenueNightSettings, 'nfcNoPinMaxCents'>): string {
  return night.nfcNoPinMaxCents > 0
    ? `Más de ${formatEur(night.nfcNoPinMaxCents, { compact: true })}: el cliente pondrá su PIN`
    : 'El cliente pondrá su PIN';
}

/** Lo de debajo del teclado del PIN: «Tápalo con la mano. Más de 20 € pide PIN.» */
export function pinFootnote(night: Pick<VenueNightSettings, 'nfcNoPinMaxCents'>): string {
  return night.nfcNoPinMaxCents > 0
    ? `Tápalo con la mano. Más de ${formatEur(night.nfcNoPinMaxCents, { compact: true })} pide PIN.`
    : 'Tápalo con la mano.';
}

/** El NO PAGADO: la razón en una frase (título y lo que pasa). */
export interface FailReason {
  title: string;
  sentence: string;
}

/**
 * Por qué no se pagó: del código del API (y, con saldo insuficiente, lo que
 * tiene y lo que falta). Lo que no se reconoce, con la frase del API.
 */
export function failReasonOf(
  err: { code?: string | null; message?: string } | null,
  ctx: { totalCents: number; wallet?: { code: string; balanceCents: number } | null } = { totalCents: 0 },
): FailReason {
  const code = err?.code ?? null;
  switch (code) {
    case 'WALLET_INSUFFICIENT': {
      const w = ctx.wallet;
      if (!w) return { title: 'Saldo insuficiente', sentence: 'No le llega el saldo para este cobro.' };
      const missing = Math.max(0, ctx.totalCents - w.balanceCents);
      return {
        title: 'Saldo insuficiente',
        sentence: `Tiene ${formatEur(w.balanceCents, { compact: true })} en ${w.code}. Faltan ${formatEur(missing, { compact: true })}.`,
      };
    }
    case 'WALLET_BLOCKED':
      return { title: 'Saldo bloqueado', sentence: 'Este saldo está bloqueado: que pague con el QR desde su móvil.' };
    case 'WALLET_CLOSED':
      return { title: 'Saldo cerrado', sentence: 'Este saldo ya está cerrado: que pague con el QR desde su móvil.' };
    case 'CHARGE_OTHER_VENUE':
      return { title: 'Saldo de otro local', sentence: 'Su saldo no vale en este local.' };
    case 'CHARGE_EXPIRED':
      return { title: 'Ha caducado', sentence: 'El cobro caducó antes de pagarse.' };
    case 'CARD_DECLINED':
      return { title: 'Tarjeta rechazada', sentence: 'El banco no ha aceptado la tarjeta.' };
    default:
      return { title: 'No se ha cobrado', sentence: err?.message || 'No se ha podido cobrar.' };
  }
}

/**
 * El reparto de una copa con invitación (2.5): la chica y el local. La barra
 * (el camarero que la cobra) solo tiene parte si el local se la da (Ajustes:
 * de fábrica, nada).
 */
export interface InvitationSplit {
  chicaCents: number;
  /** La parte de quien la cobra (solo si es camarero y el local le da algo). */
  barraCents: number;
  localCents: number;
}

export function invitationSplit(
  rules: Pick<InvitationRules, 'chica' | 'camarero'>,
  priceCents: number,
  chargerIsWaiter: boolean,
): InvitationSplit {
  const { beneficiaryCents, chargerCents } = invitationShares(rules, { unitCents: priceCents, qty: 1 }, { getsShare: chargerIsWaiter });
  return { chicaCents: beneficiaryCents, barraCents: chargerCents, localCents: priceCents - beneficiaryCents - chargerCents };
}

/**
 * Las casillas del reparto: la chica y el local; la barra, solo si se lleva
 * algo (y entonces el local, solo si le queda algo).
 */
export function splitCells(
  split: InvitationSplit,
  names: { chica: string; barra: string },
): Array<{ label: string; cents: number }> {
  const cells = [{ label: names.chica, cents: split.chicaCents }];
  if (split.barraCents > 0) cells.push({ label: names.barra, cents: split.barraCents });
  if (split.localCents > 0 || split.barraCents === 0) cells.push({ label: 'Local', cents: split.localCents });
  return cells;
}

/** «Soy Carlos · camarero». */
const ROLE_WORD: Readonly<Record<string, string>> = {
  OPERATOR: 'chica',
  WAITER: 'camarero',
  MANAGER: 'encargado',
  OWNER: 'dueño',
};

export function whoLine(name: string | null | undefined, role: string): string {
  const word = ROLE_WORD[role] ?? '';
  return [name?.trim() || null, word || null].filter(Boolean).join(' · ');
}
