// Esperando y resultado (maqueta 3.1–3.4, 2.4–2.5): lo que se enseña de un
// cobro mientras espera el NFC o el QR, y en su PAGADO / NO PAGADO. Funciones
// puras (se prueban sin pantalla).

import {
  chargeBreakdownText,
  invitationShares,
  topUpChargeText,
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

/** Lo que dice el PAGADO: lo vendido, la propina y lo que pagó el cliente. */
export interface PaidAmounts {
  baseCents: number;
  /** «Comisión del servicio» (solo si pagó con tarjeta y el local la tiene): va encima, es de OxioPay. */
  serviceFeeCents?: number;
  /** null: con tarjeta, la propina del cliente aún no se sabe (solo llegó el estado). */
  tipCents: number | null;
  totalCents: number;
}

/**
 * Las cifras del PAGADO. `cobro.totalCents` ya lleva la propina que se puso en
 * la cuenta (`cobro.tipCents`). Con tarjeta manda la que eligió el cliente en
 * su página (la de la cuenta va marcada y puede cambiarla): no se suma dos
 * veces; mientras no se sepa (`null`), el total de la cuenta, sin línea de
 * propina. Con el saldo, la de la cuenta (no se puede cambiar).
 */
export function paidAmounts(
  cobro: { totalCents: number; tipCents?: number | null; serviceFeeCents?: number | null },
  outcome: { method: PaidMethod; tipCents: number | null },
): PaidAmounts {
  const accountTip = Math.max(0, cobro.tipCents ?? 0);
  const baseCents = cobro.totalCents - accountTip;
  if (outcome.method !== 'card') return { baseCents, tipCents: accountTip, totalCents: cobro.totalCents };
  // Con tarjeta, la «Comisión del servicio» (sobre lo vendido, nunca sobre la propina).
  const fee = Math.max(0, cobro.serviceFeeCents ?? 0);
  const withFee = fee > 0 ? { serviceFeeCents: fee } : {};
  if (outcome.tipCents === null) return { baseCents, ...withFee, tipCents: null, totalCents: cobro.totalCents + fee };
  const tipCents = Math.max(0, outcome.tipCents);
  return { baseCents, ...withFee, tipCents, totalCents: baseCents + fee + tipCents };
}

/** PAGADO con la comisión del servicio: «33 € + 3,30 € comisión del servicio + 2 € propina»; sin ella, null (tipLine). */
export function paidBreakdown(amounts: PaidAmounts): string | null {
  const fee = amounts.serviceFeeCents ?? 0;
  if (fee <= 0) return null;
  return chargeBreakdownText({ baseCents: amounts.baseCents, feeCents: fee, tipCents: amounts.tipCents ?? 0 });
}

/**
 * El datáfono: «Cobra 36,30 € (33 € + 3,30 € comisión del servicio)»; una
 * recarga, «Cobra 56 € (50 € de saldo + 6 € de comisión del servicio)». El
 * API ya manda en `amountCents` lo que se cobra (con la comisión); un API de
 * antes, sin el desglose: «Cobra 33 €».
 */
export function posChargeLine(p: { amountCents: number; baseAmountCents?: number; serviceFeeCents?: number; topUp?: boolean }): string {
  const fee = Math.max(0, p.serviceFeeCents ?? 0);
  const base = p.baseAmountCents ?? p.amountCents - fee;
  if (fee === 0) return `Cobra ${formatEur(p.amountCents, { compact: true })}`;
  if (p.topUp) return topUpChargeText(base, fee);
  return `Cobra ${formatEur(base + fee, { compact: true })} (${chargeBreakdownText({ baseCents: base, feeCents: fee, tipCents: 0 })})`;
}

/**
 * Lo que se manda al confirmar un cobro del datáfono manual: el código del
 * ticket y lo que se cobró, que es lo que enseña la lista (el API ya manda en
 * `amountCents` el total con la comisión del servicio). Con la comisión, el
 * API no confirma sin ello.
 */
export function posConfirmBody(
  p: { amountCents: number; baseAmountCents?: number; serviceFeeCents?: number },
  posReceiptRef: string,
  photo?: string | null,
): { posReceiptRef: string; chargedCents: number; posReceiptPhoto?: string } {
  return { posReceiptRef, chargedCents: p.amountCents, ...(photo ? { posReceiptPhoto: photo } : {}) };
}

/** Lo que se cobra con tarjeta o datáfono: el importe + la comisión del servicio (sin la propina). */
export function chargeWithFeeCents(p: { amountCents: number; serviceFeeCents?: number | null }): number {
  return p.amountCents + Math.max(0, p.serviceFeeCents ?? 0);
}

/**
 * El QR de un cobro con la comisión del servicio: «Con tarjeta, 36,30 € (33 € +
 * 3,30 € comisión del servicio)»; el de una recarga, «Cobra 56 € (50 € de
 * saldo + 6 € de comisión del servicio)». Sin ella, null.
 */
export function paymentFeeLine(p: { amountCents: number; serviceFeeCents?: number | null; walletId?: string | null }): string | null {
  const fee = Math.max(0, p.serviceFeeCents ?? 0);
  if (fee === 0) return null;
  if (p.walletId) return topUpChargeText(p.amountCents, fee);
  return waitingFeeHint({ totalCents: p.amountCents, card: { serviceFeeCents: fee }, saldo: null });
}

/**
 * Esperando, con la comisión del servicio: lo que paga con tarjeta (con ella)
 * y lo que paga con el saldo (sin ella). Sin ella, null.
 */
export function waitingFeeHint(cobro: {
  totalCents: number;
  tipCents?: number | null;
  card: { serviceFeeCents?: number | null } | null;
  saldo: unknown;
}): string | null {
  const fee = Math.max(0, cobro.card?.serviceFeeCents ?? 0);
  if (fee === 0) return null;
  const tip = Math.max(0, cobro.tipCents ?? 0);
  const short = (cents: number) => formatEur(cents, { compact: true });
  const card = `Con tarjeta, ${short(cobro.totalCents + fee)} (${chargeBreakdownText({ baseCents: cobro.totalCents - tip, feeCents: fee, tipCents: tip })})`;
  return cobro.saldo ? `${card} · con el saldo, ${short(cobro.totalCents)}` : card;
}

/** «33 € + 2 € de propina» (la propina, aparte para resaltarla); sin propina (o sin saberla), null. */
export function tipLine(amounts: PaidAmounts): { base: string; tip: string } | null {
  if (amounts.tipCents === null || amounts.tipCents <= 0) return null;
  return { base: formatEur(amounts.baseCents, { compact: true }), tip: formatEur(amounts.tipCents, { compact: true }) };
}

/**
 * Pagó con el NFC o el PIN y no llegó la respuesta (red, servidor caído): no
 * se sabe si se cobró. Se sigue preguntando por el cobro y decide su estado.
 */
export const CHECKING_TEXT = 'Comprobando si se ha cobrado…';
/** Ya se sabe: el cobro sigue pendiente (no llegó a cobrarse). */
export const NOT_CHARGED_RETRY_TEXT = 'No llegó a cobrarse: que vuelva a acercar el NFC o escanee el QR.';

/** La ficha pasa del máximo sin PIN y no lo tiene. No es un rechazo: su saldo sigue ahí y hay salida. */
export const NO_PIN_TITLE = 'Falta el PIN de esta ficha';
export const NO_PIN_SENTENCE = 'Su saldo sigue ahí. Que lo ponga con el encargado, o que pague este cobro con el QR.';

/**
 * La pastilla viva de «Esperando» (y lo que oye el lector de pantalla): cambia
 * solo al cambiar de fase, no cada segundo. Con `checking`, comprobando si el
 * pago que se quedó sin respuesta se cobró.
 */
export function waitingLiveText(phase: 'ok' | 'ending' | 'over', checking = false): string {
  if (checking) return CHECKING_TEXT;
  if (phase === 'over') return 'Comprobando…';
  if (phase === 'ending') return 'Queda menos de un minuto';
  return 'Esperando el pago…';
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
