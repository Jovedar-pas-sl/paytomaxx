// «Pantalla del cliente» (/pantalla): qué se enseña según lo que dice el API.
// El API manda (el «Pagado» sale de la base); aquí solo se decide cuánto rato
// se enseña cada cosa: «Pagado» unos segundos y vuelta sola al reposo;
// cancelado, caducado o fallido: el reposo con un texto corto.

import type { CustomerScreenEnd, CustomerScreenView, TipPreset } from '@nightpay/contracts';
import { formatEur } from './money';

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
  | { kind: 'paid'; until: number };

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
      ? { kind: 'paid', until: now + PAID_SHOW_MS }
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
  return fichas ? 'Paga con tu ficha o con el QR' : 'Paga con el QR';
}

/**
 * Debajo del importe: qué hacer. `nfcHere`: esta tablet lee fichas (Android
 * con Chrome): la ficha vale en ella o en el móvil del camarero.
 */
export function waitingHint(view: WaitingView, nfcHere = false): string {
  if (view.paying) return 'Terminando el pago…';
  if (view.ficha) {
    const where = nfcHere ? 'Acerca tu ficha a esta pantalla o al móvil del camarero' : 'Acerca tu ficha al móvil del camarero';
    // Con propina, la ficha siempre pide el PIN (la confirma el cliente).
    return (view.tip?.chosenCents ?? 0) > 0 ? `${where} y pon tu PIN` : where;
  }
  if (!view.qrUrl) return 'Paga en el datáfono';
  return 'Escanea el QR con tu móvil';
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

/** El botón de una propina sugerida: «+2 €» o «10 % · +3 €». */
export function tipButtonLabel(preset: TipPreset): string {
  const plus = `+${formatEur(preset.cents, { compact: true })}`;
  return preset.percent ? `${preset.percent} % · ${plus}` : plus;
}

/** Con «Comisión del servicio»: lo que paga la tarjeta («Con tarjeta, 36,30 €»). */
export function cardLine(view: WaitingView): string | null {
  return view.cardAmountCents !== null ? `Con tarjeta, ${formatEur(view.cardAmountCents, { compact: true })}` : null;
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
