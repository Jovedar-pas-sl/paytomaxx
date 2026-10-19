// Cierre de la noche en pasos (panel): lógica pura de la pantalla de cierre.
// Las reglas de verdad (efectivo esperado, qué bloquea, qué hay que confirmar)
// vienen de @nightpay/contracts: el API cierra con las mismas.

import {
  MAX_TYPED_AMOUNT_CENTS,
  NIGHT_CLOSE_STEP_KEYS,
  closeNoteRequired,
  evaluateCash,
  nightCloseRefusal,
  parseEuroCents,
  withCashInput,
  type CashInput,
  type CashOutcome,
  type NightCash,
  type NightCloseLink,
  type NightCloseStatus,
  type NightCloseStep,
  type NightCloseStepKey,
} from '@nightpay/contracts';
import { formatEur } from './money';
import type { PanelTab, TabKey } from './roles';

/** Efectivo tecleado: undefined = vacío (no lo ha puesto), null = no es un importe. */
export function parseCashInput(text: string): number | null | undefined {
  const s = text.trim();
  if (s === '') return undefined;
  // parseEuroCents no acepta 0; en la caja, «0» es una respuesta válida.
  if (/^0+(?:[.,]0{1,2})?\s*€?$/.test(s)) return 0;
  return parseEuroCents(s, MAX_TYPED_AMOUNT_CENTS);
}

/** Lo que hay tecleado en el paso del efectivo. */
export interface CashDraft {
  /** Fondo de caja (solo si no se puso al abrir, o para corregirlo). */
  floatText: string;
  countedText: string;
}

/**
 * Lo tecleado → la entrada de las reglas (lo que no es un importe cuenta como
 * vacío). `floatApproved`: el dueño puso su código 2FA para cambiar el fondo
 * apuntado al abrir (el API lo comprueba al cerrar).
 */
export function cashInputOf(draft: CashDraft, floatApproved = false): CashInput {
  const float = parseCashInput(draft.floatText);
  const counted = parseCashInput(draft.countedText);
  return {
    openingFloatCents: typeof float === 'number' ? float : undefined,
    countedCents: typeof counted === 'number' ? counted : undefined,
    ...(floatApproved ? { floatChangeApproved: true } : {}),
  };
}

/** Los pasos con el efectivo tecleado (como los recalcula el API al cerrar). */
export function effectiveSteps(
  steps: ReadonlyArray<NightCloseStep>,
  cash: NightCash,
  draft: CashDraft,
  floatApproved = false,
): NightCloseStep[] {
  return withCashInput(steps, cash, cashInputOf(draft, floatApproved));
}

export function cashOutcome(cash: NightCash, draft: CashDraft, floatApproved = false): CashOutcome {
  return evaluateCash(cash, cashInputOf(draft, floatApproved));
}

/**
 * Cambiar al cerrar el fondo apuntado al abrir: solo el dueño, con su código
 * 2FA (6 cifras; el API lo comprueba). null: no hace falta código (el fondo no
 * cambió). Si no, el código que se manda (o undefined si aún no vale).
 */
export function floatChangeCode(
  cash: NightCash,
  draft: CashDraft,
  who: { isOwner: boolean; code: string },
): { needed: false } | { needed: true; code: string | undefined } {
  if (!cashOutcome(cash, draft).floatChanged) return { needed: false };
  const code = who.isOwner && /^\d{6}$/.test(who.code) ? who.code : undefined;
  return { needed: true, code };
}

/** Lo que se dice al encargado que cambia el fondo apuntado al abrir. */
export const FLOAT_OWNER_ONLY_TEXT =
  'Solo el dueño puede cambiar al cerrar el fondo apuntado al abrir (con su 2FA). Deja el que se apuntó o pídeselo.';

/** Diferencia de caja en palabras: «Faltan 12,50 €», «Sobran 5,00 €», «Cuadra». */
export function diffLabel(diffCents: number): string {
  if (diffCents === 0) return 'Cuadra';
  return `${diffCents < 0 ? 'Faltan' : 'Sobran'} ${formatEur(Math.abs(diffCents))}`;
}

/** «Recargas del saldo en efectivo: 80,00 € (2).» (los Z de antes no traen el número). */
export function cajaInText(caja: { cashInCents: number; walletCashTopUpsCount?: number; walletCashTopUpsCents?: number }): string {
  const count = caja.walletCashTopUpsCount;
  return `Recargas del saldo en efectivo: ${formatEur(caja.walletCashTopUpsCents ?? caja.cashInCents)}${
    typeof count === 'number' ? ` (${count})` : ''
  }.`;
}

/** Un aviso confirmado: el paso y cómo estaba al confirmarlo (su huella). */
export interface StepAck {
  readonly key: NightCloseStepKey;
  readonly print: string;
}

/**
 * La huella de un paso: lo que se confirmó (el texto con sus importes, el
 * recuento y cada cosa con su importe; sin las etiquetas, que llevan «hace N
 * min»). Si cambia, el aviso es otro y hay que volver a confirmarlo.
 */
export function stepPrint(step: NightCloseStep): string {
  const items = step.items.map((i) => `${i.id}:${i.status}:${i.amountCents ?? ''}`).join(',');
  return `${step.count}|${step.detail}|${items}`;
}

/** Marca un aviso como visto tal como está ahora (o lo desmarca), sin cambiar la lista de entrada. */
export function toggleAck(acks: ReadonlyArray<StepAck>, step: NightCloseStep, on: boolean): StepAck[] {
  const rest = acks.filter((a) => a.key !== step.key);
  return on ? [...rest, { key: step.key, print: stepPrint(step) }] : rest;
}

/**
 * Los avisos que siguen confirmados con los pasos de ahora: el paso sigue en
 * aviso y no ha cambiado desde que se confirmó (p. ej. «Faltan 12,50 €» que
 * pasa a «Faltan 32,50 €» tras otra recarga ya no cuenta como visto).
 */
export function ackedKeys(acks: ReadonlyArray<StepAck>, steps: ReadonlyArray<NightCloseStep>): NightCloseStepKey[] {
  const byKey = new Map(steps.map((s) => [s.key, s] as const));
  return acks
    .filter((a) => {
      const s = byKey.get(a.key);
      return s?.status === 'warn' && stepPrint(s) === a.print;
    })
    .map((a) => a.key);
}

export interface FreezeState {
  canFreeze: boolean;
  /** Por qué no se puede aún (para leer debajo del botón). */
  reason: string | null;
  noteRequired: boolean;
}

/** ¿Se puede pulsar «Congelar el Z»? Mismas reglas que el API (nightCloseRefusal). */
export function freezeState(
  steps: ReadonlyArray<NightCloseStep>,
  acks: ReadonlyArray<NightCloseStepKey>,
  note: string,
): FreezeState {
  const refusal = nightCloseRefusal(steps, acks, note);
  const noteRequired = closeNoteRequired(steps);
  if (!refusal) return { canFreeze: true, reason: null, noteRequired };
  if (refusal.kind === 'note-required') {
    return { canFreeze: false, reason: 'Escribe por qué cierras con cobros sin terminar.', noteRequired };
  }
  const titles = refusal.steps.map((s) => `«${s.title}»`).join(', ');
  return {
    canFreeze: false,
    reason: refusal.kind === 'blocked' ? `Falta resolver: ${titles}.` : `Confirma que lo has visto: ${titles}.`,
    noteRequired,
  };
}

/** Cómo se lee cada estado (texto, no solo color). */
export const STATUS_LABEL: Record<NightCloseStatus, string> = {
  ok: 'Listo',
  warn: 'Aviso',
  block: 'Bloquea',
};

/** Pestaña del panel a la que lleva un paso (null si no hay o este rol no la ve). */
export function stepTab(link: NightCloseLink | null, tabs: ReadonlyArray<PanelTab>): PanelTab | null {
  if (!link) return null;
  const key: TabKey = link;
  return tabs.find((t) => t.key === key) ?? null;
}

/** Cuántos pasos están listos (para la barra de progreso): los ok y los avisos ya confirmados. */
export function readyCount(steps: ReadonlyArray<NightCloseStep>, acks: ReadonlyArray<NightCloseStepKey> = []): number {
  return steps.filter((s) => s.status === 'ok' || (s.status === 'warn' && acks.includes(s.key))).length;
}

/**
 * Pasos que manda el API en un 409 (NIGHT_CLOSE_BLOCKED / NEEDS_ACK); null si
 * el cuerpo no los trae o no son pasos.
 */
export function stepsFromBody(text: string): NightCloseStep[] | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const steps = (body as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps) || !steps.every(isStep)) return null;
  return steps;
}

const STEP_KEYS: ReadonlySet<string> = new Set(NIGHT_CLOSE_STEP_KEYS);
const STATUSES: ReadonlySet<string> = new Set(['ok', 'warn', 'block']);

function isStep(v: unknown): v is NightCloseStep {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.key === 'string' &&
    STEP_KEYS.has(s.key) &&
    typeof s.status === 'string' &&
    STATUSES.has(s.status) &&
    typeof s.title === 'string' &&
    typeof s.detail === 'string' &&
    Array.isArray(s.items)
  );
}
