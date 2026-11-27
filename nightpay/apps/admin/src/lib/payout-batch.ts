// «Pagar a varias a la vez» (entrega 11 B): quién se marca, el tope, la barra,
// los textos del repaso y del resultado y qué hacer cuando falla. Lógica pura
// (probada en payout-batch.test.ts). Los textos son los del encargo: nunca el
// mensaje del servidor.

import {
  PAYOUT_BATCH_MAX_ITEMS,
  PAYOUT_BATCH_NEEDS_APPROVAL,
  PAYOUT_BATCH_NEEDS_APPROVAL_MESSAGE,
  PAYOUT_BATCH_CHANGED_MESSAGE,
  PASSKEY_REQUIRED_CODE,
  STAFF_PERMISSION_DENIED_CODE,
  type PayoutBatchItemResult,
  type PayoutBatchProblem,
  type PayoutBatchProblemCode,
  type PayoutBatchResult,
  type StepUpMethod,
} from '@nightpay/contracts';
import { PAYOUT_METHOD_SHORT } from '../components/PayoutMethodForm';
import type { Operator, PayoutMethod } from './api';
import { ApiError, humanizeTotpError, totpLockedUntil } from './api-errors';
import { formatDateTime } from './dates';
import { PayoutBatchChangedError } from './endpoints/operators';
import { formatEur } from './money';
import { KEY_REUSED_CODE, KEY_REUSED_TEXT } from './payout-attempt';

/** Cuántas caben en una tanda (lo mismo que el API). */
export const BATCH_MAX = PAYOUT_BATCH_MAX_ITEMS;

/** Sin 2FA ni llave (y el 403 TOTP_NOT_ENROLLED): el mismo texto que el API. */
export const BATCH_2FA_TEXT =
  'Para pagar a varias a la vez hace falta la verificación en dos pasos o una llave de acceso (Ajustes → Seguridad). Mientras, págales una a una.';

export const NO_PERMISSION_TEXT = 'No tienes permiso para pagar';

export const BATCH_LOST_TEXT =
  'No sabemos si se apuntaron todos: el servidor no contestó y puede que siga apuntándolos. Espera un minuto y pulsa «Volver a cargar la lista» antes de repetir nada.';

const OTHER_FAILURE_TEXT = 'No se ha apuntado ningún pago. Vuelve a probar.';
const PASSKEY_TEXT = 'Confírmalo con tu llave de acceso.';

/**
 * Quién paga a la chica desde una fila: el dueño siempre; el encargado lo pide
 * al dueño si el local lo exige o paga él con 2FA si no. null = no se enseña.
 */
export function payoutModeFor(isOwner: boolean, rule: string | undefined): 'pay' | 'pay_2fa' | 'request' | null {
  if (isOwner) return 'pay';
  if (rule === 'request') return 'request';
  if (rule === 'direct_2fa') return 'pay_2fa';
  return null;
}

/**
 * Qué se puede hacer en la lista. `tick`: casillas y barra. `one-by-one`: sin
 * 2FA ni llave, «Pagar» por fila. `request`: «Pedir al dueño» por fila.
 * `no-permission` y `look`: solo mirar (sin reglas o permisos aún, también).
 */
export type BatchAccess = 'tick' | 'one-by-one' | 'request' | 'no-permission' | 'look';

export function batchAccess(input: {
  isOwner: boolean;
  rule: string | undefined;
  /** Permiso «pagos» del encargado; undefined = no se sabe (aún o falló). El dueño, siempre. */
  canPay: boolean | undefined;
  /** useStepUpMethod: undefined aún no se sabe (se intenta con el código). */
  method: StepUpMethod | null | undefined;
}): BatchAccess {
  if (!input.isOwner && input.canPay === false) return 'no-permission';
  if (!input.isOwner && input.canPay === undefined) return 'look';
  const mode = payoutModeFor(input.isOwner, input.rule);
  if (mode === null) return 'look';
  if (mode === 'request') return 'request';
  if (input.method === null) return 'one-by-one';
  return 'tick';
}

/** «Transferencia» para SEPA y Wire; lo demás, su nombre corto. */
export function methodWord(method: PayoutMethod): string {
  if (method === 'SEPA_IBAN' || method === 'WIRE_INTERNATIONAL') return 'Transferencia';
  return PAYOUT_METHOD_SHORT[method] ?? method;
}

/** «Marta», o «Luis · camarero». */
export function personName(op: Pick<Operator, 'displayName' | 'email'>, waiter: boolean): string {
  const name = op.displayName ?? op.email;
  return waiter ? `${name} · camarero` : name;
}

export type RowState =
  | { kind: 'tick'; cents: number }
  /** Sin casilla: se paga una a una (su código dice por qué). */
  | { kind: 'blocked'; code: PayoutBatchProblemCode; payableFrom?: string }
  /** El encargado ya lo pidió (solo lo ve el dueño). */
  | { kind: 'pending'; by: string }
  /** API antiguo sin availableCents: sin casilla. */
  | { kind: 'unknown' };

/** Lo mismo que mira el API en el repaso, con lo que la lista ya trae. */
export function rowState(op: Operator, now: number, pendingBy?: string): RowState {
  if (pendingBy !== undefined) return { kind: 'pending', by: pendingBy };
  if (op.payoutMethod === 'MANUAL_CASH') return { kind: 'blocked', code: 'CASH' };
  if (!op.payoutMethod || !op.payoutAddressMasked) return { kind: 'blocked', code: 'NO_ACCOUNT' };
  const until = op.payoutHoldUntil ? Date.parse(op.payoutHoldUntil) : Number.NaN;
  if (op.payoutHoldUntil && !Number.isNaN(until) && until > now) {
    return { kind: 'blocked', code: 'PAYOUT_ACCOUNT_TOO_NEW', payableFrom: op.payoutHoldUntil };
  }
  if (op.payoutHolderUnconfirmed) return { kind: 'blocked', code: 'PAYOUT_HOLDER_UNCONFIRMED' };
  const cents = op.balance.availableCents;
  if (cents === undefined) return { kind: 'unknown' };
  return { kind: 'tick', cents };
}

/** El texto de cada problema (de la fila, del 409 o del resultado). */
export function problemText(
  p: { code: PayoutBatchProblemCode; payableFrom?: string; totalCents?: number },
  ctx: { tz: string; expectedCents?: number },
): string {
  switch (p.code) {
    case 'NOT_FOUND':
      return 'Ya no está en el local';
    case 'NO_ACCOUNT':
      return 'Sin cuenta de cobro: se paga una a una';
    case 'CASH':
      return 'Cobra en efectivo: se paga una a una';
    case 'PAYOUT_ACCOUNT_TOO_NEW':
      return p.payableFrom
        ? `Cuenta cambiada hace poco: se le puede pagar desde el ${formatDateTime(p.payableFrom, ctx.tz, 'short')}`
        : 'Cuenta cambiada hace poco';
    case 'PAYOUT_HOLDER_UNCONFIRMED':
      return 'Falta confirmar que la cuenta es suya';
    case 'APPROVAL_ALREADY_PENDING':
      return 'Ya está pedido al dueño';
    case 'PAYOUT_CHANGED':
      if (p.totalCents === undefined) return 'No se pudo apuntar';
      return ctx.expectedCents === undefined
        ? `Ahora son ${formatEur(p.totalCents)}`
        : `Ahora son ${formatEur(p.totalCents)}, no ${formatEur(ctx.expectedCents)}`;
    case 'NOTHING_TO_PAY':
      return 'Ya no tiene nada por cobrar: puede que se le acabe de pagar';
    case 'UNKNOWN':
      return 'No sabemos si se apuntó: mira su ficha antes de volver a pagarle';
    case 'SKIPPED':
      return 'Sin apuntar: se paró antes de llegar a ella';
    case 'OTHER':
    default:
      return 'No se pudo apuntar';
  }
}

/** Marcadas: id → la cifra que se vio. */
export type Ticked = ReadonlyMap<string, number>;

/** «Todas»: marcada si van todas (o las 50 que caben), a medias si van algunas. */
export function allToggle(tickable: readonly string[], ticked: Ticked): { checked: boolean; indeterminate: boolean } {
  const on = tickable.filter((id) => ticked.has(id)).length;
  const full = on > 0 && on >= Math.min(tickable.length, BATCH_MAX);
  return { checked: full, indeterminate: on > 0 && !full };
}

/** Tocar «Todas»: con todas (o 50) marcadas, ninguna; si no, las primeras 50 en orden. */
export function tickAll(tickable: readonly string[], cents: ReadonlyMap<string, number>, ticked: Ticked): Map<string, number> {
  if (allToggle(tickable, ticked).checked) return new Map();
  const next = new Map<string, number>();
  for (const id of tickable) {
    if (next.size >= BATCH_MAX) break;
    const c = cents.get(id);
    if (c !== undefined) next.set(id, c);
  }
  return next;
}

/** Con 50 marcadas, las demás apagadas. */
export function tickDisabled(id: string, ticked: Ticked): boolean {
  return ticked.size >= BATCH_MAX && !ticked.has(id);
}

/** La suma de lo marcado: la misma que hace el API con las cifras enviadas. */
export function tickedTotal(ticked: Ticked): number {
  let sum = 0;
  for (const c of ticked.values()) sum += c;
  return sum;
}

/** «Pagar a 6: 1.840,00 €»; sin nadie, «Marca a quién pagas». */
export function barText(ticked: Ticked): string {
  if (ticked.size === 0) return 'Marca a quién pagas';
  return `Pagar a ${ticked.size}: ${formatEur(tickedTotal(ticked))}`;
}

/** Tras recargar: siguen marcadas las de igual cifra y sin problema. */
export function keepTicked(prev: Ticked, now: ReadonlyMap<string, number>, problems: ReadonlySet<string>): Map<string, number> {
  const next = new Map<string, number>();
  for (const [id, cents] of prev) {
    if (!problems.has(id) && now.get(id) === cents) next.set(id, cents);
  }
  return next;
}

const pagos = (n: number) => (n === 1 ? '1 pago' : `${n} pagos`);

export function reviewTexts(n: number): { title: string; confirm: string; submit: string; sending: string; reason: string; next: string } {
  const submit = `Apuntar ${pagos(n)}`;
  return {
    title: n === 1 ? 'Repasa el pago' : `Repasa los ${n} pagos`,
    confirm: n === 1 ? 'Ya he pagado este importe a su cuenta' : `Ya he pagado estos ${n} importes, cada uno a su cuenta`,
    submit,
    sending: `Apuntando ${pagos(n)}…`,
    reason: `Para apuntar ${pagos(n)}`,
    next: `Ahora pulsa «${submit}».`,
  };
}

export const REVIEW_EXPLAIN =
  'Aquí apuntas pagos que ya has hecho por fuera. Al confirmar, a cada persona le llega “Te han pagado” y lo de esta lista queda pagado; lo que aún está en espera se paga otro día. El justificante, si quieres, se añade luego en su ficha.';

/** «6 pagos apuntados · 1.840,00 €» o «Apuntados 4 de 6 · 1.240,00 €» (la suma del API). */
export function resultTitle(result: PayoutBatchResult): string {
  const all = result.results.length;
  if (result.paidCount === all) {
    return `${result.paidCount === 1 ? '1 pago apuntado' : `${result.paidCount} pagos apuntados`} · ${formatEur(result.paidCents)}`;
  }
  return `Apuntados ${result.paidCount} de ${all} · ${formatEur(result.paidCents)}`;
}

/** Visto, aspa, reloj (no se sabe) o guion (no se intentó). */
export function resultMark(r: Pick<PayoutBatchItemResult, 'status' | 'code'>): 'check' | 'close' | 'clock' | 'minus' {
  if (r.status === 'PAID') return 'check';
  if (r.status === 'SKIPPED') return 'minus';
  return r.code === 'UNKNOWN' ? 'clock' : 'close';
}

/** Lo que se desmarca en la lista, con su texto, tras un resultado. */
export function notesAfter(results: readonly PayoutBatchItemResult[]): PayoutBatchProblem[] {
  return results
    .filter((r) => r.status !== 'PAID')
    .map((r) => ({
      operatorId: r.operatorId,
      code: r.code ?? (r.status === 'SKIPPED' ? 'SKIPPED' : 'OTHER'),
      ...(r.payableFrom ? { payableFrom: r.payableFrom } : {}),
      ...(r.totalCents !== undefined ? { totalCents: r.totalCents } : {}),
    }));
}

export type BatchFailure =
  /** 409 PAYOUT_BATCH_CHANGED: cada problema en su fila; nadie pagado. */
  | { kind: 'changed'; text: string; problems: PayoutBatchProblem[]; keyDies: true }
  /** Sin respuesta o 5xx: puede que sí. */
  | { kind: 'unknown'; text: string; keyDies: true }
  /** El encargado que pide o sin permiso: su texto, recargar reglas y permisos y cerrar. */
  | { kind: 'close'; text: string; keyDies: boolean }
  /** Esta clave ya no sirve (otro 409): volver a la lista. */
  | { kind: 'dead'; text: string; keyDies: true }
  /** Probar otra vez aquí, con la misma clave (otro código…). */
  | { kind: 'retry'; text: string; clearCode: boolean; keyDies: false }
  | { kind: 'locked'; text: string | null; until: number; keyDies: false }
  | { kind: 'passkey'; text: string; keyDies: false };

export function batchFailure(err: unknown, now: number): BatchFailure {
  if (err instanceof PayoutBatchChangedError) {
    return { kind: 'changed', text: PAYOUT_BATCH_CHANGED_MESSAGE, problems: err.problems, keyDies: true };
  }
  if (!(err instanceof ApiError) || err.status === 0 || err.status >= 500) {
    return { kind: 'unknown', text: BATCH_LOST_TEXT, keyDies: true };
  }
  const locked = totpLockedUntil(err, now);
  if (locked !== null) return { kind: 'locked', text: null, until: locked, keyDies: false };
  if (err.code === PAYOUT_BATCH_NEEDS_APPROVAL) return { kind: 'close', text: PAYOUT_BATCH_NEEDS_APPROVAL_MESSAGE, keyDies: true };
  if (err.code === STAFF_PERMISSION_DENIED_CODE) return { kind: 'close', text: NO_PERMISSION_TEXT, keyDies: false };
  if (err.code === KEY_REUSED_CODE) return { kind: 'dead', text: KEY_REUSED_TEXT, keyDies: true };
  if (err.status === 409) return { kind: 'dead', text: PAYOUT_BATCH_CHANGED_MESSAGE, keyDies: true };
  if (err.code === PASSKEY_REQUIRED_CODE) return { kind: 'passkey', text: PASSKEY_TEXT, keyDies: false };
  if (err.code === 'TOTP_NOT_ENROLLED') return { kind: 'retry', text: BATCH_2FA_TEXT, clearCode: true, keyDies: false };
  if (err.code?.startsWith('TOTP_')) return { kind: 'retry', text: humanizeTotpError(err.message, err.code), clearCode: true, keyDies: false };
  return { kind: 'retry', text: OTHER_FAILURE_TEXT, clearCode: false, keyDies: false };
}
