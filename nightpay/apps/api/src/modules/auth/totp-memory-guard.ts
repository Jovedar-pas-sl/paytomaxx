import type { LockPolicy } from './lockout.service';
import { TOTP_WINDOW, totpStepAt } from './totp-code';

interface GuardEntry {
  readonly fails: number;
  readonly windowEndsAt: number;
  readonly lockedUntil: number;
  readonly lastStep: number;
}

const EMPTY: GuardEntry = { fails: 0, windowEndsAt: 0, lockedUntil: 0, lastStep: -1 };
const DEFAULT_MAX_ENTRIES = 1000;

/**
 * Límite de intentos y anti-reutilización EN MEMORIA, para la API síncrona
 * antigua de TotpService (assertIfEnrolled / verify), que no puede esperar a
 * Redis. Es por proceso: con varias réplicas, cada una lleva su cuenta. Lo
 * bueno es la API por usuario (assertForUser…), que usa Redis.
 *
 * La clave es una huella del secreto (cada usuario tiene uno distinto).
 */
export class TotpMemoryGuard {
  private readonly entries = new Map<string, GuardEntry>();
  private readonly policy: LockPolicy;
  private readonly maxEntries: number;

  constructor(policy: LockPolicy, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.policy = policy;
    this.maxEntries = maxEntries;
  }

  /** Segundos de bloqueo que quedan (0 = no bloqueado). */
  lockedFor(key: string): number {
    const left = this.read(key).lockedUntil - Date.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  /** Cuenta un fallo; devuelve true si con él queda bloqueado. */
  recordFailure(key: string): boolean {
    const now = Date.now();
    const entry = this.read(key);
    const fails = entry.fails + 1;
    const windowEndsAt = entry.fails === 0 ? now + this.policy.windowSec * 1000 : entry.windowEndsAt;
    if (fails < this.policy.threshold) {
      this.write(key, { ...entry, fails, windowEndsAt });
      return false;
    }
    this.write(key, { ...entry, fails: 0, windowEndsAt: 0, lockedUntil: now + this.policy.lockSec * 1000 });
    return true;
  }

  clearFailures(key: string): void {
    this.write(key, { ...this.read(key), fails: 0, windowEndsAt: 0 });
  }

  /** Acepta el paso solo si es posterior al último aceptado con este secreto. */
  claimStep(key: string, step: number): boolean {
    const entry = this.read(key);
    if (step <= entry.lastStep) return false;
    this.write(key, { ...entry, lastStep: step });
    return true;
  }

  size(): number {
    return this.entries.size;
  }

  private read(key: string): GuardEntry {
    const entry = this.entries.get(key) ?? EMPTY;
    const windowExpired = entry.fails > 0 && entry.windowEndsAt <= Date.now();
    return windowExpired ? { ...entry, fails: 0, windowEndsAt: 0 } : entry;
  }

  private write(key: string, entry: GuardEntry): void {
    this.entries.set(key, entry);
    if (this.entries.size > this.maxEntries) this.prune();
  }

  /** Quita lo que ya no aporta: sin bloqueo, sin fallos vivos y con un paso ya caducado. */
  private prune(): void {
    const now = Date.now();
    const oldestUsefulStep = totpStepAt(now) - TOTP_WINDOW - 1;
    for (const [key, entry] of this.entries) {
      const idle = entry.lockedUntil <= now && (entry.fails === 0 || entry.windowEndsAt <= now);
      if (idle && entry.lastStep < oldestUsefulStep) this.entries.delete(key);
    }
  }
}
