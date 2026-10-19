import { z } from 'zod';
import { MAX_TYPED_AMOUNT_CENTS } from './money';

// ═══════════════════════════════════════════════════════════════════════
// Cierre de la noche en pasos, con el arqueo de caja.
//
//   GET  /v1/nights/current/close-check → NightCloseCheck
//   POST /v1/nights/open                 OpenNightDto  → la noche abierta
//   POST /v1/nights/:id/close            CloseNightDto → la noche cerrada
//        409 NIGHT_CLOSE_BLOCKED   { steps }           un paso bloquea
//        409 NIGHT_CLOSE_NEEDS_ACK { steps, missing }  avisos sin confirmar
//        400 NIGHT_CLOSE_NOTE_REQUIRED                 cobros sin terminar y sin nota
//
// Las reglas de aquí (efectivo esperado, qué bloquea, qué falta confirmar)
// las usan el API al cerrar y el panel para habilitar «Congelar el Z»:
// cuentan igual en los dos sitios.
// ═══════════════════════════════════════════════════════════════════════

export const NIGHT_CLOSE_STEP_KEYS = ['cobros', 'datafonos', 'saldo', 'efectivo', 'chicas', 'incidencias', 'z'] as const;
export type NightCloseStepKey = (typeof NIGHT_CLOSE_STEP_KEYS)[number];

/** ok = listo · warn = se puede cerrar confirmándolo · block = no se puede cerrar aún. */
export type NightCloseStatus = 'ok' | 'warn' | 'block';

/** Sección del panel a la que lleva el botón del paso. */
export type NightCloseLink = 'payments' | 'terminals' | 'wallets' | 'operators' | 'incidents';

/** Una cosa concreta dentro de un paso (un cobro, un datáfono, una chica…). */
export interface NightCloseItem {
  id: string;
  status: NightCloseStatus;
  label: string;
  amountCents: number | null;
}

export interface NightCloseStep {
  key: NightCloseStepKey;
  status: NightCloseStatus;
  title: string;
  /** Una frase: qué pasa y qué hacer. */
  detail: string;
  count: number;
  link: NightCloseLink | null;
  items: NightCloseItem[];
}

/**
 * Efectivo de la noche (desde el cierre anterior, como el Z). Entra por las
 * recargas del saldo en efectivo (recepción) y sale por el saldo devuelto en
 * efectivo y los pagos en efectivo a las chicas.
 */
export interface NightCash {
  /** Fondo de caja con el que empezó la noche (null = nadie lo apuntó). */
  openingFloatCents: number | null;
  /** Efectivo que entra por OxioPay: las recargas en efectivo. */
  cashInCents: number;
  walletCashTopUpsCount: number;
  walletCashTopUpsCents: number;
  walletCashPayoutsCount: number;
  walletCashPayoutsCents: number;
  chicaCashPayoutsCount: number;
  chicaCashPayoutsCents: number;
  cashOutCents: number;
  /** Fondo + entradas − salidas (con el fondo guardado; sin él, como si fuera 0). */
  expectedCents: number;
}

/** Lo que hay que pagar a una chica al cerrar. */
export interface NightChicaPay {
  operatorId: string;
  name: string;
  payoutMethod: string | null;
  payoutAddress: string | null;
  payoutLabel: string | null;
  /** Lo que se le paga ahora con «Pagar» (ya liberado por los días de espera, menos su deuda). */
  toPayCents: number;
  /** Ganado y aún en espera (días de espera del local). */
  heldCents: number;
  /** Ganado desde el cierre anterior (pagado o no). */
  earnedTonightCents: number;
  /** Pagado desde el cierre anterior. */
  paidTonightCents: number;
  paidTonightCount: number;
  /** Devoluciones llegadas con la comisión ya pagada: se descuentan del siguiente pago. */
  debtCents: number;
}

export interface NightCloseCheck {
  nightId: string;
  openedAt: string;
  /** Desde dónde cuenta el Z (el cierre anterior o, la primera noche, la apertura). */
  from: string;
  generatedAt: string;
  /** Días de espera para pagar a las chicas en este local (0 = al cierre de la noche). */
  holdDays: number;
  steps: NightCloseStep[];
  cash: NightCash;
  chicas: NightChicaPay[];
}

/** Efectivo tecleado: de 0 a 100.000 €, en céntimos. */
const CashCentsSchema = z.number().int().min(0).max(MAX_TYPED_AMOUNT_CENTS);

export const OpenNightSchema = z
  .object({
    /** Fondo de caja al abrir (opcional: también se puede poner al cerrar). */
    openingFloatCents: CashCentsSchema.optional(),
  })
  .default({});
export type OpenNightDto = z.infer<typeof OpenNightSchema>;

export const CloseNightSchema = z.object({
  /** Pasos en aviso que quien cierra ha visto y confirma. */
  acknowledged: z.array(z.enum(NIGHT_CLOSE_STEP_KEYS)).max(NIGHT_CLOSE_STEP_KEYS.length).optional().default([]),
  /** Por qué se cierra con cobros sin terminar (obligatoria en ese caso). */
  note: z.string().trim().max(300).optional(),
  /** Efectivo contado en la caja (obligatorio si hubo efectivo o fondo). */
  cashCountedCents: CashCentsSchema.optional(),
  /** Fondo de caja, si no se puso al abrir (o para corregirlo). */
  openingFloatCents: CashCentsSchema.optional(),
  /** Explicación de la diferencia de caja. */
  cashNote: z.string().trim().max(300).optional(),
});
export type CloseNightDto = z.infer<typeof CloseNightSchema>;

// ─── Caja: reglas puras ─────────────────────────────────────────────

/** Lo que debería haber en la caja: fondo + entradas − salidas. */
export function expectedCashCents(
  openingFloatCents: number | null,
  moves: { cashInCents: number; cashOutCents: number },
): number {
  return (openingFloatCents ?? 0) + moves.cashInCents - moves.cashOutCents;
}

/** Lo que teclea quien cierra (null/undefined = no lo ha puesto). */
export interface CashInput {
  openingFloatCents?: number | null;
  countedCents?: number | null;
}

export type CashReason = 'not-needed' | 'float-missing' | 'count-missing' | 'matches' | 'short' | 'over';

export interface CashOutcome {
  /** El fondo que vale: el tecleado o, si no, el guardado. */
  floatCents: number | null;
  expectedCents: number;
  countedCents: number | null;
  /** Contado − esperado (negativo = falta dinero). */
  diffCents: number | null;
  /** Hay que contar: hubo efectivo o hay fondo. */
  required: boolean;
  reason: CashReason;
  status: NightCloseStatus;
  detail: string;
}

/**
 * El paso «Efectivo» con lo tecleado:
 *  - sin efectivo ni fondo → no hace falta contar (ok);
 *  - salió efectivo y nadie dijo el fondo → bloquea (sin fondo, lo esperado sería negativo);
 *  - hay que contar y no se ha contado → bloquea;
 *  - contado ≠ esperado → aviso (se confirma y la diferencia va al Z);
 *  - cuadra → ok.
 */
export function evaluateCash(cash: NightCash, input: CashInput = {}): CashOutcome {
  const floatCents = input.openingFloatCents ?? cash.openingFloatCents;
  const moves = { cashInCents: cash.cashInCents, cashOutCents: cash.cashOutCents };
  const expectedCents = expectedCashCents(floatCents, moves);
  const countedCents = input.countedCents ?? null;
  const moved = moves.cashInCents > 0 || moves.cashOutCents > 0;
  const required = moved || (floatCents ?? 0) > 0;
  const diffCents = countedCents === null ? null : countedCents - expectedCents;
  const base = { floatCents, expectedCents, countedCents, diffCents, required };

  if (moved && floatCents === null) {
    return {
      ...base,
      reason: 'float-missing',
      status: 'block',
      detail: `${cashMovesText(moves)}: apunta con cuánto empezó la caja (el fondo) y cuéntala.`,
    };
  }
  if (required && countedCents === null) {
    return {
      ...base,
      reason: 'count-missing',
      status: 'block',
      detail: `Cuenta el efectivo de la caja: debería haber ${eur(expectedCents)}.`,
    };
  }
  if (diffCents !== null && diffCents !== 0) {
    const short = diffCents < 0;
    return {
      ...base,
      reason: short ? 'short' : 'over',
      status: 'warn',
      detail: `${short ? 'Faltan' : 'Sobran'} ${eur(Math.abs(diffCents))}: confírmalo y la diferencia queda en el Z.`,
    };
  }
  if (!required) {
    return { ...base, reason: 'not-needed', status: 'ok', detail: 'Sin efectivo esta noche: no hace falta contar la caja.' };
  }
  return { ...base, reason: 'matches', status: 'ok', detail: `La caja cuadra: ${eur(expectedCents)}.` };
}

/** «Entraron 50,00 € y salieron 20,00 € en efectivo» (lo que se movió). */
function cashMovesText(moves: { cashInCents: number; cashOutCents: number }): string {
  if (moves.cashInCents > 0 && moves.cashOutCents > 0) {
    return `Entraron ${eur(moves.cashInCents)} y salieron ${eur(moves.cashOutCents)} en efectivo`;
  }
  return moves.cashInCents > 0
    ? `Entraron ${eur(moves.cashInCents)} en efectivo`
    : `Salieron ${eur(moves.cashOutCents)} en efectivo`;
}

/** Movimientos de efectivo de la noche (recargas, saldo devuelto y pagos a chicas). */
export function cashMovesCount(cash: NightCash): number {
  return (cash.walletCashTopUpsCount ?? 0) + cash.walletCashPayoutsCount + cash.chicaCashPayoutsCount;
}

/** Los pasos con el de «Efectivo» recalculado con lo tecleado (no cambia el array de entrada). */
export function withCashInput(steps: ReadonlyArray<NightCloseStep>, cash: NightCash, input: CashInput): NightCloseStep[] {
  const outcome = evaluateCash(cash, input);
  return steps.map((s) =>
    s.key === 'efectivo' ? { ...s, status: outcome.status, detail: outcome.detail, count: cashMovesCount(cash) } : s,
  );
}

// ─── Qué impide cerrar ──────────────────────────────────────────────

export type NightCloseRefusal =
  | { kind: 'blocked'; steps: NightCloseStep[] }
  | { kind: 'needs-ack'; steps: NightCloseStep[] }
  | { kind: 'note-required' };

/** Con cobros o devoluciones sin terminar, se cierra explicando por qué. */
export function closeNoteRequired(steps: ReadonlyArray<NightCloseStep>): boolean {
  return steps.some((s) => s.key === 'cobros' && s.status === 'warn');
}

/** Una nota vale con al menos 3 letras. */
export const MIN_CLOSE_NOTE_LENGTH = 3;

/**
 * null = se puede congelar el Z. Si no, lo primero que lo impide: un paso
 * que bloquea, avisos sin confirmar o falta la nota de los cobros.
 */
export function nightCloseRefusal(
  steps: ReadonlyArray<NightCloseStep>,
  acknowledged: ReadonlyArray<NightCloseStepKey>,
  note: string | null | undefined,
): NightCloseRefusal | null {
  const blocked = steps.filter((s) => s.status === 'block');
  if (blocked.length > 0) return { kind: 'blocked', steps: blocked };
  const acked = new Set(acknowledged);
  const pending = steps.filter((s) => s.status === 'warn' && !acked.has(s.key));
  if (pending.length > 0) return { kind: 'needs-ack', steps: pending };
  if (closeNoteRequired(steps) && (note?.trim().length ?? 0) < MIN_CLOSE_NOTE_LENGTH) return { kind: 'note-required' };
  return null;
}

function eur(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${whole},${String(abs % 100).padStart(2, '0')} €`;
}
