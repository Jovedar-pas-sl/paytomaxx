/**
 * Intento de cobro: la Idempotency-Key va con lo que se cobra. Si la cajera
 * reintenta lo mismo (p. ej. tras un tiempo agotado) se reutiliza y el API
 * devuelve el mismo cobro, no un QR nuevo. Si cambia el importe o el
 * terminal, o el cobro anterior salió bien, la clave es nueva.
 */
export interface ChargeAttempt {
  readonly key: string;
  /** Lo que se cobra: importe y terminal. */
  readonly fingerprint: string;
}

export function chargeFingerprint(amountCents: number, terminalExternalId: string): string {
  return `${amountCents}|${terminalExternalId}`;
}

export function attemptFor(previous: ChargeAttempt | null, fingerprint: string): ChargeAttempt {
  return previous?.fingerprint === fingerprint ? previous : { key: newKey(), fingerprint };
}

/** UUID v4; fuera de HTTPS (sin randomUUID) 32 hex aleatorios, que el API también acepta. */
function newKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
