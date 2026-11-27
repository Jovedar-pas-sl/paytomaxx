// «Pantalla del cliente» (/pantalla): qué se enseña según lo que dice el API.
// El API manda (el «Pagado» sale de la base); aquí solo se decide cuánto rato
// se enseña cada cosa: «Pagado» unos segundos y vuelta sola al reposo;
// cancelado, caducado o fallido: el reposo con un texto corto.

import type { CustomerDisplayMessage, CustomerScreenEnd, CustomerScreenView, TipPreset } from '@nightpay/contracts';
import { formatEur } from './money';
import { enEur, type Bilingual } from './pin-tip';

/** «Pagado» a pantalla completa. */
export const PAID_SHOW_MS = 6_000;
/** El texto corto de un cobro que no se pagó. */
export const ENDED_SHOW_MS = 4_000;
/** Cobros que se recuerdan (para no repetir su «Pagado»). */
const MEMORY = 20;

export type WaitingView = Extract<CustomerScreenView, { state: 'waiting' }>;

export type Shown =
  | { kind: 'idle'; note: string | null; until: number | null }
  | { kind: 'waiting'; view: WaitingView }
  /** `cents`: lo pagado (null: un API de antes no lo manda). */
  | { kind: 'paid'; until: number; cents: number | null };

export interface PantallaMemory {
  shown: Shown;
  /** Cobros que esta tablet vio esperando: solo de esos se enseña cómo acabaron. */
  seen: readonly string[];
  /** Cobros cuyo final ya se enseñó. */
  done: readonly string[];
}

export const INITIAL_MEMORY: PantallaMemory = { shown: { kind: 'idle', note: null, until: null }, seen: [], done: [] };

const remember = (list: readonly string[], key: string): readonly string[] =>
  list.includes(key) ? list : [...list, key].slice(-MEMORY);

const IDLE: Shown = { kind: 'idle', note: null, until: null };

/** Algo que se está enseñando unos segundos (el «Pagado» o el texto corto) y aún no ha acabado. */
function holding(shown: Shown, now: number): boolean {
  return 'until' in shown && shown.until !== null && shown.until > now;
}

export function endedNote(reason: CustomerScreenEnd): string {
  if (reason === 'expired') return 'El QR ha caducado';
  if (reason === 'failed') return 'No se ha podido pagar';
  return 'Cobro cancelado';
}

/** Lo nuevo del API sobre lo que ya se enseña. */
export function nextMemory(mem: PantallaMemory, view: CustomerScreenView, now: number): PantallaMemory {
  if (view.state === 'waiting') {
    // Un cobro nuevo manda sobre el «Pagado» del anterior.
    return { ...mem, shown: { kind: 'waiting', view }, seen: remember(mem.seen, view.key) };
  }
  if (view.state === 'idle') {
    return holding(mem.shown, now) ? mem : { ...mem, shown: IDLE };
  }
  // Pagado o sin pagar: solo si esta tablet lo vio esperando y aún no enseñó su final.
  if (mem.done.includes(view.key) || !mem.seen.includes(view.key)) {
    return holding(mem.shown, now) ? mem : { ...mem, shown: IDLE };
  }
  const shown: Shown =
    view.state === 'paid'
      ? { kind: 'paid', until: now + PAID_SHOW_MS, cents: typeof view.paidCents === 'number' ? view.paidCents : null }
      : { kind: 'idle', note: endedNote(view.reason), until: now + ENDED_SHOW_MS };
  return { ...mem, shown, done: remember(mem.done, view.key) };
}

/** Pasó el rato del «Pagado» o del texto corto: al reposo. */
export function expireMemory(mem: PantallaMemory, now: number): PantallaMemory {
  const timed = 'until' in mem.shown && mem.shown.until !== null;
  return timed && !holding(mem.shown, now) ? { ...mem, shown: IDLE } : mem;
}

/** En reposo: cómo se paga en este local. */
export function idleHint(fichas: boolean): string {
  return idleHintText(fichas).es;
}

/** Lo mismo, con su inglés debajo (idea 70). */
export function idleHintText(fichas: boolean): Bilingual {
  return fichas ? { es: 'Paga con tu ficha o con el QR', en: 'Pay with your tag or the QR' } : { es: 'Paga con el QR', en: 'Pay with the QR' };
}

/**
 * Los textos fijos de la tablet con su inglés (idea 70): el cliente puede no
 * hablar español. El inglés va debajo de cada uno, más suave.
 */
export const SCREEN_TEXT = {
  topUp: { es: 'Recarga de saldo', en: 'Balance top-up' },
  reading: { es: 'Leyendo la ficha…', en: 'Reading your tag…' },
  payingPhone: { es: 'Pagando en el móvil del cliente…', en: "Paying on the customer's phone…" },
  orQr: { es: 'o escanea el QR con tu móvil', en: 'or scan the QR with your phone' },
  tip: { es: '¿Propina?', en: 'Tip?' },
  noTip: { es: 'Sin propina', en: 'No tip' },
  other: { es: 'Otra', en: 'Other' },
  withBalance: { es: 'Con saldo', en: 'With balance' },
  byCard: { es: 'Con tarjeta', en: 'By card' },
  paid: { es: 'Pagado', en: 'Paid' },
  thanks: { es: '¡Gracias!', en: 'Thank you' },
} as const satisfies Record<string, Bilingual>;

/** El reposo: el nombre del local, cómo se paga y su mensaje (Ajustes → Carta → «Pantalla del cliente»). */
export interface RestView {
  name: string;
  fichas: boolean;
  line1: string | null;
  line2: string | null;
}

/** Lo del reposo de cualquier vista del API (llega en todas: se tiene para cuando vuelva). */
export function restOf(view: CustomerScreenView): RestView {
  // Un API de antes no manda el mensaje: solo el nombre.
  const m: Partial<CustomerDisplayMessage> = view.message ?? {};
  const lines = [m.line1, m.line2].filter((l): l is string => Boolean(l));
  return { name: view.venueName, fichas: view.fichas, line1: lines[0] ?? null, line2: lines[1] ?? null };
}

/** Cada cuánto se mueve un poco el reposo, para que no se quede marcado en la pantalla. */
export const REST_SHIFT_MS = 60_000;

/** Los sitios por los que pasa (vmin desde el centro, 2 como mucho): una vuelta cada 8 minutos. */
const REST_SHIFTS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1.5, -1],
  [-1, 1.5],
  [2, 1],
  [-1.5, -1.5],
  [1, 2],
  [-2, 0.5],
  [0.5, -2],
];

/** Dónde va el reposo en el minuto `step` (cualquier entero, también negativo). */
export function restShift(step: number): { x: number; y: number } {
  const n = REST_SHIFTS.length;
  const [x, y] = REST_SHIFTS[((step % n) + n) % n]!;
  return { x, y };
}

/**
 * Debajo del importe: qué hacer. `nfcHere`: esta tablet lee fichas (Android
 * con Chrome): la ficha vale en ella o en el móvil del camarero.
 */
export function waitingHint(view: WaitingView, nfcHere = false): string {
  return waitingHintText(view, nfcHere).es;
}

/** Lo mismo, con su inglés debajo (idea 70). */
export function waitingHintText(view: WaitingView, nfcHere = false): Bilingual {
  if (view.paying) return { es: 'Terminando el pago…', en: 'Finishing the payment…' };
  if (view.ficha) {
    const where = nfcHere
      ? { es: 'Acerca tu ficha a esta pantalla o al móvil del camarero', en: "Hold your tag to this screen or the waiter's phone" }
      : { es: 'Acerca tu ficha al móvil del camarero', en: "Hold your tag to the waiter's phone" };
    // Con propina, la ficha siempre pide el PIN (la confirma el cliente).
    return (view.tip?.chosenCents ?? 0) > 0 ? { es: `${where.es} y pon tu PIN`, en: `${where.en} and enter your PIN` } : where;
  }
  if (!view.qrUrl) return { es: 'Paga en el datáfono', en: 'Pay on the card reader' };
  return { es: 'Escanea el QR con tu móvil', en: 'Scan the QR with your phone' };
}

/** El importe grande: lo vendido + la propina elegida («33 €», «35 €»). */
export function amountText(view: WaitingView): string {
  return formatEur(view.totalCents, { compact: true });
}

/** «33 € + 2 € de propina» cuando eligió una; sin propina, null. */
export function tipBreakdown(view: WaitingView): string | null {
  const tip = view.tip?.chosenCents ?? 0;
  if (tip <= 0) return null;
  return `${formatEur(view.amountCents, { compact: true })} + ${formatEur(tip, { compact: true })} de propina`;
}

/** El botón de una propina sugerida: «+3 €», sin «%» (idea 66: lo que se ve es lo que se paga). */
export function tipButtonLabel(preset: TipPreset): string {
  return `+${formatEur(preset.cents, { compact: true })}`;
}

/**
 * Con «Comisión del servicio» (idea 70): los precios que se enseñan, igual de
 * grandes. Con ficha, con saldo (sin comisión) y con tarjeta; sin ficha (nadie
 * paga el otro), solo con tarjeta. Sin comisión, null: un importe, como siempre.
 * Los dos llevan la propina elegida; la comisión va solo sobre lo vendido.
 */
export function pricesOf(view: WaitingView): { saldoCents: number | null; cardCents: number; feeCents: number } | null {
  if (view.cardAmountCents === null) return null;
  return {
    saldoCents: view.ficha ? view.totalCents : null,
    cardCents: view.cardAmountCents,
    feeCents: view.cardAmountCents - view.totalCents,
  };
}

/** La comisión, con su importe, antes de elegir cómo pagar. */
export function feeNote(feeCents: number): Bilingual {
  return {
    es: `Incluye ${formatEur(feeCents, { compact: true })} de comisión del servicio`,
    en: `Includes a ${enEur(feeCents)} service fee`,
  };
}

/**
 * El total que se enseña bajo cada propina: el precio de la pantalla sin la
 * propina elegida (con tarjeta, si es el único precio). Con dos precios, null:
 * sin total (serían dos).
 */
export function tipTotalBase(view: WaitingView): number | null {
  const prices = pricesOf(view);
  if (prices && prices.saldoCents !== null) return null;
  const chosen = view.tip?.chosenCents ?? 0;
  return (prices ? prices.cardCents : view.totalCents) - chosen;
}

/** La sugerida o «Otra» que sale marcada: «Otra» si la elegida no es una sugerida. */
export function isOtherTip(view: WaitingView): boolean {
  const chosen = view.tip?.chosenCents ?? 0;
  return chosen > 0 && !(view.tip?.presets ?? []).some((p) => p.cents === chosen);
}

/** «Otra» se ofrece si caben al menos 1 € (como en /pay). */
export function otherTipOffered(view: WaitingView): boolean {
  return (view.tip?.maxCents ?? 0) >= 100;
}

/**
 * La propina de «Otra» tecleada en la tablet: euros enteros, más de 0 y hasta
 * el tope (lo mismo que npTipOther en /pay), o por qué aún no vale.
 */
export function otherTipOf(text: string, maxCents: number): { cents: number; error: 'empty' | 'max' | null } {
  const digits = text.replace(/[^0-9]/g, '');
  const euros = digits ? Number.parseInt(digits, 10) : 0;
  if (!(euros > 0)) return { cents: 0, error: 'empty' };
  if (euros * 100 > maxCents) return { cents: 0, error: 'max' };
  return { cents: euros * 100, error: null };
}

/** «Como mucho 33 €» (el tope en euros enteros). */
export function otherTipMaxText(maxCents: number): string {
  return `Como mucho ${formatEur(Math.floor(maxCents / 100) * 100, { compact: true })}`;
}
