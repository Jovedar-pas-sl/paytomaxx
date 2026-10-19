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

/** Lo tecleado → la entrada de las reglas (lo que no es un importe cuenta como vacío). */
export function cashInputOf(draft: CashDraft): CashInput {
  const float = parseCashInput(draft.floatText);
  const counted = parseCashInput(draft.countedText);
  return {
    openingFloatCents: typeof float === 'number' ? float : undefined,
    countedCents: typeof counted === 'number' ? counted : undefined,
  };
}

/** Los pasos con el efectivo tecleado (como los recalcula el API al cerrar). */
export function effectiveSteps(steps: ReadonlyArray<NightCloseStep>, cash: NightCash, draft: CashDraft): NightCloseStep[] {
  return withCashInput(steps, cash, cashInputOf(draft));
}

export function cashOutcome(cash: NightCash, draft: CashDraft): CashOutcome {
  return evaluateCash(cash, cashInputOf(draft));
}

/** Diferencia de caja en palabras: «Faltan 12,50 €», «Sobran 5,00 €», «Cuadra». */
export function diffLabel(diffCents: number): string {
  if (diffCents === 0) return 'Cuadra';
  return `${diffCents < 0 ? 'Faltan' : 'Sobran'} ${formatEur(Math.abs(diffCents))}`;
}

/** Marca un aviso como visto (o lo desmarca), sin cambiar la lista de entrada. */
export function toggleAck(
  acks: ReadonlyArray<NightCloseStepKey>,
  key: NightCloseStepKey,
  on: boolean,
): NightCloseStepKey[] {
  const rest = acks.filter((k) => k !== key);
  return on ? [...rest, key] : rest;
}

/** Tras recargar los pasos: solo siguen confirmados los que siguen en aviso. */
export function keepAcks(acks: ReadonlyArray<NightCloseStepKey>, steps: ReadonlyArray<NightCloseStep>): NightCloseStepKey[] {
  const warned = new Set(steps.filter((s) => s.status === 'warn').map((s) => s.key));
  return acks.filter((k) => warned.has(k));
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
