// Cuenta atrás del QR y el «hace 0:12» del resultado. Funciones puras: la
// hora de ahora la pone quien llama (un useNow), así se prueban sin relojes.

import type { PaymentStatus } from '../components/StatusPill';

/** El plazo de un QR en el reloj de este aparato. */
export interface QrDeadline {
  readonly startMs: number;
  readonly endMs: number;
}

/** Últimos segundos: la barra se pone ámbar y el texto dice «pronto». */
export const ENDING_SECONDS = 60;

/**
 * Margen tras la hora de caducar antes de darlo por caducado aquí sin que lo
 * diga el servidor (socket caído). El servidor ya no deja empezar a pagar un
 * QR caducado; el margen cubre un pago que empezó en el último segundo.
 */
export const LOCAL_EXPIRY_GRACE_MS = 5_000;

/**
 * Plazo del QR en el reloj de este aparato. Con la hora de creación del
 * servidor, dura lo que dijo el servidor (caduca − creado) desde que llegó la
 * respuesta: un móvil con la hora adelantada no da por caducado un QR que aún
 * vale. Sin ella, la hora de caducar tal cual. null si la fecha no vale.
 */
export function qrDeadline(
  expiresAt: string,
  receivedAtMs: number,
  createdAt?: string | null,
): QrDeadline | null {
  const end = Date.parse(expiresAt);
  if (!Number.isFinite(end)) return null;
  const created = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (Number.isFinite(created) && end > created) {
    return { startMs: receivedAtMs, endMs: receivedAtMs + (end - created) };
  }
  return { startMs: Math.min(receivedAtMs, end), endMs: end };
}

/** Segundos que le quedan (redondeando hacia arriba: «0:00» solo cuando ya caducó). */
export function secondsLeft(deadline: QrDeadline, nowMs: number): number {
  return Math.max(0, Math.ceil((deadline.endMs - nowMs) / 1000));
}

/** Lo que queda del plazo, de 1 (recién creado) a 0 (caducado). */
export function remainingFraction(deadline: QrDeadline, nowMs: number): number {
  const total = deadline.endMs - deadline.startMs;
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, (deadline.endMs - nowMs) / total));
}

export type CountdownPhase = 'ok' | 'ending' | 'over';

export function countdownPhase(seconds: number, endingAt: number = ENDING_SECONDS): CountdownPhase {
  if (seconds <= 0) return 'over';
  return seconds <= endingAt ? 'ending' : 'ok';
}

/** 272 → "4:32"; 3725 → "1:02:05". */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = String(s % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** Tiempo desde que pasó, para el resultado: "hace 0:12". */
export function agoLabel(sinceMs: number, nowMs: number): string {
  return `hace ${formatClock((nowMs - sinceMs) / 1000)}`;
}

/** Antes de que el cliente empiece a pagar: aún se puede cancelar o caducar. */
export function isPreCobro(status: PaymentStatus): boolean {
  return status === 'CREATED' || status === 'AWAITING_CAPTURE';
}

/**
 * El estado que se enseña: el del servidor, salvo un QR que nadie empezó a
 * pagar y cuyo plazo pasó (más el margen): ese ya es CADUCADO aunque el aviso
 * del servidor no haya llegado (socket caído).
 */
export function effectiveStatus(
  status: PaymentStatus,
  deadline: QrDeadline | null,
  nowMs: number,
  graceMs: number = LOCAL_EXPIRY_GRACE_MS,
): PaymentStatus {
  if (!deadline || !isPreCobro(status)) return status;
  return nowMs >= deadline.endMs + graceMs ? 'EXPIRED' : status;
}
