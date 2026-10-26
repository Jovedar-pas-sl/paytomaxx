// Recepción exprés en el móvil del personal (maquetas 4.1–4.7): Entrada
// (acercar el NFC, el importe y cómo paga: tres toques) y Salida (guardar el
// saldo para la próxima o devolverlo en efectivo); y «Recargar saldo» en
// Inicio. NFC = tarjeta, ficha o pulsera: se trata igual. Las llamadas y la
// lógica pura de cada paso (probada en reception-desk.test.ts).

import {
  fichaLabel,
  MAX_CASH_TOP_UP_CENTS,
  NEW_FICHA_BY_NUMBER_MESSAGE,
  type ReceptionDeskSaldo,
  type ReceptionDeskView,
  type ReceptionNumberTopUpDto,
  type ReceptionNumberTopUpResult,
  type ReceptionNumberView,
  type ReceptionOptions,
  type SaldoRefDto,
} from '@nightpay/contracts';
import { ApiError } from '@nightpay/api-client';
import { authedFetch, parseOperatorApiError } from './api';
import { formatEur } from './money';
import { payProblem, receptionWhat, topUpCharge, walletOfTarget, type PayMethod, type Target } from './reception';
import type { TopUpWalletDto } from '@nightpay/contracts';

export type { ReceptionDeskSaldo, ReceptionDeskView, ReceptionNumberView };
export type NumberSaldo = Extract<ReceptionNumberView, { kind: 'saldo' }>;

// ─── Llamadas ─────────────────────────────────────────────────────────────

/** El NFC acercado o el código tecleado → nuevo o su saldo (POST /v1/reception/desk). */
export async function fetchReceptionDesk(ref: SaldoRefDto): Promise<ReceptionDeskView> {
  const res = await authedFetch('/v1/reception/desk', { method: 'POST', body: JSON.stringify(ref) });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Saldo'));
  return res.json();
}

/**
 * Buscar la ficha por su número impreso (sin acercarla): solo el estado, el
 * código tapado (K7Q-•••) y los importes. No sirve para pagar.
 */
export async function fetchFichaByNumber(printedNumber: string): Promise<ReceptionNumberView> {
  const res = await authedFetch('/v1/reception/fichas/lookup-number', { method: 'POST', body: JSON.stringify({ printedNumber }) });
  if (!res.ok) throw new Error(await parseOperatorApiError(res, 'Ficha'));
  return res.json();
}

/** Recargar en efectivo el saldo de la ficha buscada por su número (no una nueva). */
export async function topUpByNumber(body: ReceptionNumberTopUpDto): Promise<ReceptionNumberTopUpResult> {
  const res = await authedFetch('/v1/reception/fichas/number-topup', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new ApiError(await parseOperatorApiError(res, 'Ficha'), res.status);
  return res.json();
}

/** Por qué la ficha buscada por número no se carga aquí (null: se puede, en efectivo). */
export function numberEntryProblem(view: ReceptionNumberView): string | null {
  if (view.kind === 'new') return NEW_FICHA_BY_NUMBER_MESSAGE;
  if (view.blocked) return 'Este saldo está bloqueado: no se puede recargar. Avisa al encargado.';
  return null;
}

/** «Ficha nº 00736903 · Le quedan 35 € · K7Q-•••» (por número: el código, tapado). */
export function numberRow(view: NumberSaldo): DeskRow {
  const left = view.balanceCents > 0 ? `Le quedan ${formatEur(view.balanceCents, { compact: true })}` : 'Sin saldo';
  return { title: fichaLabel(view.printedNumber), detail: `${left} · ${view.codeHint}` };
}

// ─── Lo que se enseña ─────────────────────────────────────────────────────

/**
 * «ficha nº 00736903» (en minúscula, para el medio de una frase): el número
 * impreso de fábrica. Sin él, «ficha sin número impreso» (el número interno
 * no se enseña como si fuera el impreso).
 */
export function fichaText(printedNumber?: string | null): string {
  return fichaLabel(printedNumber).replace(/^Ficha/, 'ficha');
}

/** La fila del NFC leído (4.2 y 4.5): el título y la línea de debajo. */
export interface DeskRow {
  title: string;
  detail: string;
}

/**
 * 4.2: «NFC nuevo · Ficha nº 0522 · sin saldo», o el suyo con lo que le
 * queda. 4.5 (Salida): «Ficha nº 0388 · Saldo R3D-8LP · leída». El número es
 * el impreso; sin él, «sin número impreso».
 */
export function deskRow(view: ReceptionDeskView, mode: 'entrada' | 'salida'): DeskRow {
  if (view.kind === 'new') return { title: 'NFC nuevo', detail: `${fichaLabel(view.printedNumber)} · sin saldo` };
  const title = view.fichaNumber === null ? `Saldo ${view.code}` : fichaLabel(view.printedNumber);
  const saldo = view.fichaNumber === null ? null : view.code;
  if (mode === 'salida') return { title, detail: saldo ? `Saldo ${saldo} · leída` : 'Sin NFC · por su código' };
  const left = view.balanceCents > 0 ? `Le quedan ${formatEur(view.balanceCents, { compact: true })}` : 'Sin saldo';
  return { title, detail: [left, saldo].filter(Boolean).join(' · ') };
}

/** El chip de 4.3: «Recarga · ficha nº 0522» (o «Recarga · K7Q-4M2» sin NFC, «Recarga · saldo nuevo»). */
export function rechargeChip(view: ReceptionDeskView | null): string {
  if (!view) return 'Recarga · saldo nuevo';
  if (view.fichaNumber !== null) return `Recarga · ${fichaText(view.printedNumber)}`;
  return view.kind === 'saldo' ? `Recarga · ${view.code}` : 'Recarga · saldo nuevo';
}

/** Los importes rápidos del local (Ajustes → Noche), sin repetir y de menor a mayor. */
export function quickAmounts(cents: readonly number[]): number[] {
  return [...new Set(cents.filter((c) => Number.isInteger(c) && c > 0))].sort((a, b) => a - b);
}

/** Un botón de «¿Cómo paga?»: el de la forma por defecto del local, XL y primero. */
export interface MethodButton {
  method: PayMethod;
  primary: boolean;
  /** Por qué no se puede (null: se puede). */
  problem: string | null;
}

/**
 * 4.3: efectivo y tarjeta, la de por defecto (Ajustes → Noche) primero y en
 * grande. El efectivo solo sale si lo puede cobrar (solo recepción, el
 * encargado o el dueño: lo dice el servidor en ReceptionOptions).
 */
export function methodButtons(
  options: ReceptionOptions,
  target: Target,
  amountCents: number,
  preferred: PayMethod,
): MethodButton[] {
  const offered: PayMethod[] = [];
  if (options.cash) offered.push('cash');
  if (options.card) offered.push('card');
  offered.sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0));
  // El tope legal del efectivo es lo que paga el cliente: el saldo + la comisión del servicio.
  const charge = topUpCharge(options, amountCents);
  return offered.map((method, i) => {
    const tooBig =
      method === 'cash' && charge.totalCents > MAX_CASH_TOP_UP_CENTS
        ? charge.feeCents > 0
          ? 'En efectivo, como mucho 999,99 € por pago (saldo + comisión del servicio).'
          : 'En efectivo, como mucho 999,99 € por recarga.'
        : null;
    return { method, primary: i === 0, problem: tooBig ?? payProblem(method, target, options) };
  });
}

/**
 * 4.3 para la ficha buscada por su número: solo en efectivo (la tarjeta va
 * con su NFC o su código, que se ve entero).
 */
export function numberMethodButtons(options: ReceptionOptions | null): MethodButton[] {
  if (!options) return [];
  return [
    { method: 'cash', primary: true, problem: options.cash ? null : (options.cashBlockedReason ?? 'Aquí no se cobran recargas en efectivo.') },
    { method: 'card', primary: false, problem: 'Con tarjeta, acerca su NFC o escribe su código.' },
  ];
}

/** La nota del PIN de 4.3: no frena la cola, se pone después. */
export function pinNote(noPinMaxCents: number): string {
  if (noPinMaxCents <= 0) return 'El PIN lo pone luego: hace falta para pagar con el NFC.';
  return `El PIN lo pone luego, solo hace falta para más de ${formatEur(noPinMaxCents, { compact: true })}.`;
}

/** El saldo de la recarga para la petición (y su clave): nuevo, el de su NFC o el de su código. */
export function deskTarget(view: ReceptionDeskView | null, nfc: { card: string; uid: string | null } | null): Target {
  if (!view || view.kind === 'new') return { kind: 'new' };
  const card = { walletId: view.walletId, codeHint: view.code, hasPin: view.hasPin, isHomeVenue: view.isHomeVenue };
  if (nfc) return { kind: 'card', card: nfc.card, uid: nfc.uid, view: card };
  return { kind: 'code', code: view.code, view: card };
}

/**
 * Lo que se recarga, para la clave de idempotencia: importe, forma de pago y a
 * qué saldo. Un saldo nuevo va con la ficha leída: dos clientes con ficha
 * nueva, mismo importe y misma forma de pago no comparten clave (si no, el
 * servidor devolvería la recarga del primero como si fuera la del segundo) (A2-04).
 */
export function deskRechargeWhat(
  amountCents: number,
  method: PayMethod,
  read: { view: ReceptionDeskView | null; nfc: { card: string; uid: string | null } | null; number?: NumberSaldo },
): string {
  if (read.number) return `${amountCents}|${method}|numero:${read.number.printedNumber}`;
  const target = deskTarget(read.view, read.nfc);
  const what = receptionWhat(amountCents, method, target);
  return target.kind === 'new' && read.nfc ? `${what}:ficha:${read.nfc.card}` : what;
}

/**
 * El saldo de la recarga en efectivo: uno nuevo va ya con la ficha NFC
 * acercada (el servidor la da en la misma operación). Antes la ficha se daba
 * después, en otra petición: si la respuesta de la recarga se perdía, el
 * cliente se iba con la ficha vacía y su dinero en un saldo sin ficha.
 */
export function cashTopUpWallet(target: Target, nfc: { card: string; uid: string | null } | null): TopUpWalletDto {
  if (target.kind !== 'new' || !nfc) return walletOfTarget(target);
  return nfc.uid ? { create: true, card: nfc.card, uid: nfc.uid } : { create: true, card: nfc.card };
}

/**
 * La recarga en efectivo falló: ¿pudo cargarse? Sin respuesta (red, plazo),
 * con el servidor caído (5xx, 408) o con una respuesta ilegible, sí: se
 * comprueba repitiéndola con la misma clave (no carga dos veces). Un rechazo
 * del API (4xx: tope de efectivo, bloqueado, demasiados intentos, la sesión)
 * dice que no se cargó.
 */
export function cashTopUpUnsure(err: unknown): boolean {
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'SessionExpiredError')) return false;
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') return true;
  return status === 0 || status === 408 || status >= 500;
}

/** Lo que se ve si, tras comprobarla, aún no se sabe si se cargó (sin conexión con el servidor). */
export function cashUnsureText(amount: string): string {
  return `No sabemos si se han cargado los ${amount}: se cortó la conexión. No pases al siguiente cliente: comprueba primero (no se cobra dos veces).`;
}

/** Al salir sin saberlo: lo que puede haber pasado. */
export const CASH_UNSURE_LEAVE_TEXT =
  'Puede que ya esté cargado (en su ficha, si se la acercaste). Si cobras otra vez a este cliente, se carga dos veces: compruébalo antes con el encargado.';

/** El aviso al volver a la pantalla de inicio tras salir sin saberlo. */
export const CASH_UNSURE_LEFT_NOTICE = 'Recarga sin comprobar: antes de cobrar otra vez a ese cliente, revisad sus recargas en efectivo con el encargado.';

/** Veces que se comprueba sola una recarga sin respuesta antes de pedir que se compruebe a mano. */
export const CASH_CHECK_TRIES = 3;
/** Entre una comprobación y la siguiente. */
export const CASH_CHECK_DELAY_MS = 1_500;

/** Pasos donde se lee al cliente (su NFC, su código o su número): volver a uno es otro cliente (o empezar de nuevo). */
const READ_STEPS: ReadonlySet<string> = new Set(['tap', 'code', 'number']);

/**
 * La clave de la recarga al cambiar de paso: al volver a leer (la flecha atrás
 * hasta el NFC, otro cliente) se renueva; dentro de la misma recarga (importe,
 * forma de pago, su QR) se conserva y repetir lo mismo no carga dos veces.
 */
export function attemptOnStep<A>(attempt: A | null, nextStep: string): A | null {
  return READ_STEPS.has(nextStep) ? null : attempt;
}

/** Por qué este saldo no se recarga aquí (null: se puede). */
export function rechargeProblem(view: ReceptionDeskView | null): string | null {
  if (view?.kind === 'saldo' && view.blocked) return 'Este saldo está bloqueado: no se puede recargar. Avisa al encargado.';
  return null;
}

/** 4.4: lo que hace recepción con el dinero («Efectivo: 50 € a la caja»). */
export function loadedMoneyLine(method: PayMethod, amountCents: number): { label: string; amount: string; tail: string } {
  const amount = formatEur(amountCents, { compact: true });
  return method === 'cash'
    ? { label: 'Efectivo:', amount, tail: 'a la caja' }
    : { label: 'Tarjeta:', amount, tail: 'en su móvil' };
}

/** 4.4: qué hace con el NFC («Dale el NFC · ficha nº 0522»). */
export function handOverLine(view: ReceptionDeskView | null, linked: boolean): string {
  if (view?.kind === 'saldo') return view.fichaNumber === null ? `Saldo ${view.code}` : `Devuélvele su NFC · ${fichaText(view.printedNumber)}`;
  if (view && linked) return `Dale el NFC · ${fichaText(view.printedNumber)}`;
  return 'Sin NFC: que apunte su código';
}

// ─── Salida (4.5) ─────────────────────────────────────────────────────────

/** Los dos botones de la salida: guardar (de fábrica) o devolver en efectivo. */
export interface ExitPlan {
  /** Lo que le queda. */
  balanceCents: number;
  /** «Devolver 35 € en efectivo» (null: no le queda nada). */
  refundLabel: string | null;
  /** «Sacas 35 € de la caja · el NFC vuelve al stock». */
  refundDetail: string | null;
  /** Por qué no se puede devolver aquí (null: se puede). */
  refundBlocked: string | null;
  /** Lo que no sale en efectivo (lo entró con tarjeta…), dicho antes. */
  note: string | null;
  /** Debajo de «Guardar para la próxima»: «No caduca · se lleva su NFC» (sin NFC: «que guarde su código»). */
  keepDetail: string;
}

/** Tras devolver: el NFC vuelve al stock, o lo que le queda (entró con tarjeta) y quién lo devuelve. */
export function refundDoneLine(remainingCents: number): string {
  if (remainingCents <= 0) return 'El NFC vuelve al stock: guárdalo.';
  return `Le quedan ${formatEur(remainingCents, { compact: true })} (con tarjeta): los devuelve el dueño «A la tarjeta». Se lleva su NFC.`;
}

// ─── El código tecleado ───────────────────────────────────────────────────

/** Lo tecleado → hasta 6 letras o cifras en mayúscula (sin el guion ni espacios). */
export function codeInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

/** Las seis casillas del código (4.6): «K7Q4M» → K,7,Q,4,M,''. */
export function codeBoxes(code: string): string[] {
  const c = codeInput(code);
  return Array.from({ length: 6 }, (_, i) => c[i] ?? '');
}
