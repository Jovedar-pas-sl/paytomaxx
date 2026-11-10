// Recepción exprés en el móvil del personal (maquetas 4.1–4.7): Entrada
// (acercar el NFC, el importe y cómo paga: tres toques) y Salida (guardar el
// saldo para la próxima o devolverlo en efectivo); y «Recargar saldo» en
// Inicio. NFC = tarjeta, ficha o pulsera: se trata igual. Las llamadas y la
// lógica pura de cada paso (probada en reception-desk.test.ts).

import {
  fichaLabel,
  MAX_CASH_TOP_UP_CENTS,
  RECENT_TOP_UP_MINUTES,
  type RecentTopUp,
  NEW_FICHA_BY_NUMBER_MESSAGE,
  type ReceptionDeskSaldo,
  type ReceptionDeskView,
  type ReceptionNumberTopUpDto,
  type ReceptionNumberTopUpResult,
  type ReceptionNumberView,
  type ReceptionOptions,
  type SaldoRefDto,
} from '@nightpay/contracts';
import { authedFetch, operatorApiError, parseOperatorApiError } from './api';
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
  if (!res.ok) throw await operatorApiError(res, 'Ficha');
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

/** Debajo de la ficha leída en grande (A1): que mire el número de la que tiene en la mano. */
export const FICHA_IN_HAND = 'Mira que es la que tienes en la mano';

/**
 * Buscada por su número (A6): el número se teclea y una cifra mal es la ficha
 * de otro. Que se compare con la ficha y se pregunte al cliente lo que tiene.
 */
export const FICHA_CHECK = 'Compruébalo con la ficha';

/**
 * «¿Le quedan unos 35 €?» (A6): lo que se le pregunta al cliente para saber
 * que es la suya, redondeado como lo recuerda (a 5 € desde 10 €; por debajo,
 * al euro). Sin decirle la cifra exacta.
 */
export function roughBalanceQuestion(balanceCents: number): string {
  if (balanceCents <= 0) return '¿Ya no le queda nada?';
  const euros = balanceCents / 100;
  const rough = euros >= 10 ? Math.round(euros / 5) * 5 : Math.round(euros);
  if (rough <= 0) return '¿Le queda menos de 1 €?';
  return `¿Le quedan unos ${formatEur(rough * 100, { compact: true })}?`;
}

/** La fila de «¿Cuánto carga?» (4.2) con el número de la ficha en grande (A1). */
export interface EntryRow extends DeskRow {
  /** El número impreso, en grande (null: sin ficha o sin número impreso). */
  ficha: string | null;
  /** Lo que hay que mirar al ver el número («Mira que es la que tienes en la mano»). */
  hint: string | null;
  /** Por su número (A6): lo que se le pregunta al cliente («¿Le quedan unos 35 €?»). */
  ask?: string;
}

/**
 * 4.2: la ficha leída con su número en grande («Ficha nueva», 0000 1013, «Sin
 * saldo»), la de un saldo (lo que le queda y su código), la buscada por su
 * número (el código, tapado) o el saldo sin ficha. «Mira que es la que tienes
 * en la mano», solo si se ha acercado (por el código no la tienen delante).
 */
export function entryRow(read: { view: ReceptionDeskView | null; nfc: unknown; number?: NumberSaldo }): EntryRow {
  if (read.number) {
    const n = read.number;
    return { title: 'Ficha', ficha: n.printedNumber, detail: `${leftText(n.balanceCents)} · ${n.codeHint}`, hint: FICHA_CHECK, ask: roughBalanceQuestion(n.balanceCents) };
  }
  const view = read.view;
  if (!view) return { title: 'Saldo nuevo', detail: 'Sin ficha: se queda con su código', ficha: null, hint: null };
  const printed = view.printedNumber ?? null;
  const hint = printed && read.nfc ? FICHA_IN_HAND : null;
  if (view.kind === 'new') {
    return printed
      ? { title: 'Ficha nueva', ficha: printed, detail: 'Sin saldo', hint }
      : { title: 'Ficha nueva', detail: 'Sin número impreso · sin saldo', ficha: null, hint: null };
  }
  const left = leftText(view.balanceCents);
  if (view.fichaNumber === null) return { title: `Saldo ${view.code}`, detail: `${left} · sin ficha`, ficha: null, hint: null };
  if (!printed) return { title: 'Ficha sin número impreso', detail: `${left} · ${view.code}`, ficha: null, hint: null };
  return { title: 'Ficha', ficha: printed, detail: `${left} · ${view.code}`, hint };
}

/** La última recarga de lo leído (por su ficha, su código o su número), si el servidor la dio. */
export function lastTopUpOf(read: { view: ReceptionDeskView | null; number?: NumberSaldo }): RecentTopUp | null {
  if (read.number) return read.number.lastTopUp ?? null;
  return read.view?.kind === 'saldo' ? (read.view.lastTopUp ?? null) : null;
}

/**
 * En la fila de la ficha durante 10 min (A4): «Cargada hace 2 min: 50 € en
 * efectivo (Sergio)». Para no cargar dos veces lo mismo ni dudar de si se
 * cargó. Un saldo sin ficha, «Cargado». `now`: la hora del móvil (ms).
 */
export function recentTopUpLine(topUp: RecentTopUp | null | undefined, now: number, ficha = true): string | null {
  if (!topUp) return null;
  const minutes = Math.floor((now - Date.parse(topUp.at)) / 60_000);
  if (!Number.isFinite(minutes) || minutes >= RECENT_TOP_UP_MINUTES) return null;
  const when = minutes <= 0 ? 'hace un momento' : `hace ${minutes} min`;
  const how = topUp.method === 'cash' ? 'en efectivo' : 'con tarjeta';
  const who = topUp.byName ? ` (${topUp.byName})` : '';
  return `${ficha ? 'Cargada' : 'Cargado'} ${when}: ${formatEur(topUp.amountCents, { compact: true })} ${how}${who}`;
}

function leftText(balanceCents: number): string {
  return balanceCents > 0 ? `Le quedan ${formatEur(balanceCents, { compact: true })}` : 'Sin saldo';
}

/** El número impreso de lo leído, para enseñarlo en grande (null: sin ficha o sin número impreso). */
export function readFicha(read: { view: ReceptionDeskView | null; number?: NumberSaldo }): string | null {
  if (read.number) return read.number.printedNumber;
  if (!read.view || (read.view.kind === 'saldo' && read.view.fichaNumber === null)) return null;
  return read.view.printedNumber ?? null;
}

/**
 * El chip de 4.3: «Recarga», y la ficha va en grande debajo del importe (A1);
 * sin número impreso, «Recarga · ficha sin número impreso»; sin ficha,
 * «Recarga · K7Q-4M2» o «Recarga · saldo nuevo».
 */
export function rechargeChip(view: ReceptionDeskView | null): string {
  if (!view) return 'Recarga · saldo nuevo';
  if (view.fichaNumber !== null) return view.printedNumber ? 'Recarga' : `Recarga · ${fichaText(null)}`;
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

/**
 * «¿Cómo paga?» no atiende toques hasta pasado este tiempo desde que sale: el
 * segundo toque de un doble toque en el importe («50 €») caía en «Efectivo»,
 * que carga sin más (auditoría S-1a). Medio segundo no frena a nadie.
 */
export const METHOD_ARM_MS = 500;

/** ¿Ya cuenta un toque en «¿Cómo paga?»? (`armedAt`: cuando salió la pantalla; en ms). */
export function methodArmed(armedAt: number, now: number): boolean {
  return now - armedAt >= METHOD_ARM_MS;
}

/**
 * La nota del PIN de 4.3: no frena la cola, se elige al terminar. `canChoose`:
 * si quien carga puede ponerlo ahora (canChoosePin); si no, se dice la verdad.
 */
export function pinNote(noPinMaxCents: number, canChoose = true): string {
  if (!canChoose) return pinAfterLoadText('manager', noPinMaxCents);
  if (noPinMaxCents <= 0) return 'Al terminar elegirá su PIN: hace falta para pagar con la ficha.';
  return `Si pasa de ${formatEur(noPinMaxCents, { compact: true })}, elegirá su PIN al terminar.`;
}

/**
 * Hasta cuánto paga una ficha sin PIN en este local. Como el servidor
 * (noPinProblem): con cualquiera de los dos topes a 0, sin PIN no paga nada.
 */
export function noPinLimitCents(night: { nfcNoPinMaxCents: number; nfcNoPinNightCapCents: number }): number {
  return night.nfcNoPinNightCapCents <= 0 ? 0 : Math.max(0, night.nfcNoPinMaxCents);
}

/**
 * ¿Quien carga puede poner el PIN ahora? El servidor lo deja a quien hizo la
 * primera recarga del saldo (15 min) y al encargado o al dueño: un saldo que
 * ya existía, no (una ficha perdida no se queda con un PIN nuevo en la barra).
 */
export function canChoosePin(view: ReceptionDeskView | null, role: string): boolean {
  return !view || view.kind === 'new' || role === 'MANAGER' || role === 'OWNER';
}

/**
 * Qué hacer con el PIN al terminar de cargar. Una ficha que pasa del máximo
 * sin PIN no paga en barra y su saldo no se devuelve en la salida: `ask` lo
 * pide ya (con «Ahora no»); `manager` avisa de que lo pone el encargado;
 * `offer` lo deja como opción; `none`, nada.
 */
export type PinAfterLoad = 'none' | 'offer' | 'ask' | 'manager';

export function pinAfterLoad(o: {
  wallet: { hasPin: boolean; balanceCents: number } | null;
  hasFicha: boolean;
  canChoose: boolean;
  noPinMaxCents: number;
}): PinAfterLoad {
  if (!o.wallet || o.wallet.hasPin) return 'none';
  const needed = o.hasFicha && o.wallet.balanceCents > o.noPinMaxCents;
  if (!o.canChoose) return needed ? 'manager' : 'none';
  return needed ? 'ask' : 'offer';
}

/** Lo que pasa si no lo pone (`ask`), o quién puede ponerlo (`manager`). */
export function pinAfterLoadText(need: 'ask' | 'manager', noPinMaxCents: number): string {
  const max = formatEur(noPinMaxCents, { compact: true });
  if (need === 'ask') {
    const pay = noPinMaxCents <= 0 ? 'Sin PIN esta ficha no puede pagar.' : `Sin PIN solo paga hasta ${max}.`;
    return `${pay} Para devolverle el saldo hará falta su Face ID o el encargado.`;
  }
  return noPinMaxCents <= 0
    ? 'Esta ficha no tiene PIN: no puede pagar hasta que lo ponga con el encargado.'
    : `Esta ficha no tiene PIN: solo paga hasta ${max}. Para más, que lo ponga con el encargado.`;
}

/** Tras dar ficha a quien cargó desde casa: sin PIN, dónde ponerlo (en su móvil, que es suyo). */
export function fichaGivenNote(hasPin: boolean, noPinMaxCents: number): string {
  if (hasPin) return 'Ya puede pagar acercándola.';
  const pay = noPinMaxCents <= 0 ? 'Sin PIN esta ficha no puede pagar.' : `Sin PIN solo paga hasta ${formatEur(noPinMaxCents, { compact: true })}.`;
  return `${pay} Que lo elija en su móvil, en Más → Elegir un PIN.`;
}

/** Este móvil no lee fichas (iPhone): en vez de «Acerca el NFC», lo que se puede hacer aquí. */
export function noReaderStage(mode: 'entrada' | 'salida'): { title: string; text: string } {
  return {
    title: 'Este móvil no lee fichas',
    text:
      mode === 'entrada'
        ? 'Para cargar una ficha nueva, usa el Android de recepción. Aquí puedes cargar un saldo con su código o su número.'
        : 'Para devolver efectivo, usa el Android de recepción. Aquí puedes ver lo que le queda con su código o su número.',
  };
}

/** Una ficha abierta desde el iPhone que el servidor no conoce: aún no tiene saldo. */
export function fichaLookupText(message: string): string {
  return /no encontrad/i.test(message) ? 'Esta ficha aún no tiene saldo. Para cargarla, usa el Android de recepción.' : message;
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

/**
 * La fila de arriba mientras no se sabe si se cargó la recarga en efectivo:
 * que se está comprobando, en vez de lo leído antes de cobrar («sin saldo» de
 * una ficha nueva, «Le quedan 35 €» de una que ya tenía), que puede no ser
 * verdad: el servidor quizá ya la cargó (prueba real). Lo demás, como readRow:
 * la ficha (o su código) para saber de quién es.
 */
export function cashUnsureRow(
  read: { view: ReceptionDeskView | null; nfc: { card: string; uid: string | null } | null; number?: NumberSaldo },
  amountCents: number,
  checking: boolean,
): DeskRow {
  const amount = formatEur(amountCents, { compact: true });
  const status = checking ? `comprobando la recarga de ${amount}` : `recarga de ${amount} por comprobar`;
  // Al principio de la línea, en mayúscula («Comprobando…»); detrás de la ficha, no.
  const lead = status.charAt(0).toUpperCase() + status.slice(1);
  if (read.number) return { title: fichaLabel(read.number.printedNumber), detail: `${lead} · ${read.number.codeHint}` };
  const view = read.view;
  if (!view) return { title: 'Saldo nuevo', detail: `Sin NFC · ${status}` };
  if (view.kind === 'new') return { title: 'NFC nuevo', detail: `${fichaLabel(view.printedNumber)} · ${status}` };
  if (view.fichaNumber === null) return { title: `Saldo ${view.code}`, detail: lead };
  return { title: fichaLabel(view.printedNumber), detail: `${lead} · ${view.code}` };
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

/**
 * 4.4: lo que hace recepción con el dinero («Efectivo: 50 € a la caja»): lo
 * que pagó el cliente. Con la «Comisión del servicio» (`feeCents`, la que
 * cobró el servidor), saldo + comisión: «Efectivo: 56 € a la caja (con 6 € de
 * comisión)»; antes decía 50 € y a la caja iban 56 €.
 */
export function loadedMoneyLine(method: PayMethod, amountCents: number, feeCents = 0): { label: string; amount: string; tail: string } {
  const fee = feeCents > 0 ? feeCents : 0;
  const amount = formatEur(amountCents + fee, { compact: true });
  const withFee = fee > 0 ? ` (con ${formatEur(fee, { compact: true })} de comisión)` : '';
  return method === 'cash'
    ? { label: 'Efectivo:', amount, tail: `a la caja${withFee}` }
    : { label: 'Tarjeta:', amount, tail: `en su móvil${withFee}` };
}

/**
 * 4.4: qué hace con la ficha («Dale la ficha»). Su número y el código ya van
 * en grande encima (A1, A11); sin número impreso, se dice aquí.
 */
export function handOverLine(view: ReceptionDeskView | null, linked: boolean): string {
  const which = (printed?: string | null) => (printed ? '' : ` · ${fichaText(null)}`);
  if (view?.kind === 'saldo') return view.fichaNumber === null ? 'Saldo sin ficha' : `Devuélvele su ficha${which(view.printedNumber)}`;
  if (view && linked) return `Dale la ficha${which(view.printedNumber)}`;
  return 'Sin ficha: que apunte su código';
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
