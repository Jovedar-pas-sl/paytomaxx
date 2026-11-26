import { maskIban, maskPayoutAddress, maskWalletAddress } from '@nightpay/contracts';

/** Lo que nunca se enseña ni se guarda en el registro, ni tapado. */
const SECRET_KEY = /password|secret|token|totp|pinhash|hash$|apikey|enckey|cookie|authorization|sealed/i;
/** Una clave de socio en cualquier valor (la pista «oxp_live_…a1b2» no lo es: no sigue un hex). */
const PARTNER_KEY_VALUE = /oxp_(?:live|test)_[0-9a-f]/i;
const IBAN_KEY = /iban/i;
const ADDRESS_KEY = /address/i;
const HIDDEN = '[oculto]';
const MAX_DEPTH = 8;

/**
 * Copia de un objeto (antes/después de un cambio, payload del registro) con
 * lo secreto tapado: contraseñas, tokens, secretos 2FA y hashes → "[oculto]";
 * IBAN → "ES12 •••• •••• 1234"; direcciones de cobro → según su método
 * (cripto "T…9f2a", email "a•••@dominio"). No modifica el original.
 */
export function maskSensitive(value: unknown, depth = 0, method?: string | null): unknown {
  if (typeof value === 'string') return PARTNER_KEY_VALUE.test(value) ? HIDDEN : value;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[demasiado anidado]';
  if (Array.isArray(value)) return value.map((v) => maskSensitive(v, depth + 1, method));
  const obj = value as Record<string, unknown>;
  const ownMethod = typeof obj.payoutMethod === 'string' ? obj.payoutMethod : typeof obj.method === 'string' ? obj.method : method;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, maskEntry(k, v, depth, ownMethod)]));
}

function maskEntry(key: string, v: unknown, depth: number, method: string | null | undefined): unknown {
  if (v === null || v === undefined) return v;
  if (SECRET_KEY.test(key)) return typeof v === 'boolean' ? v : HIDDEN;
  if (typeof v === 'string' && IBAN_KEY.test(key)) return maskIban(v);
  if (typeof v === 'string' && ADDRESS_KEY.test(key)) {
    return method ? maskPayoutAddress(method, v) : maskWalletAddress(v);
  }
  return maskSensitive(v, depth + 1, method);
}

/** Solo los campos que cambiaron (para no llenar el registro de lo que sigue igual). */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { before: Partial<T>; after: Partial<T> } {
  const b: Partial<T> = {};
  const a: Partial<T> = {};
  for (const key of Object.keys(after) as Array<keyof T>) {
    if (after[key] === undefined) continue;
    if (JSON.stringify(before[key] ?? null) === JSON.stringify(after[key] ?? null)) continue;
    b[key] = before[key];
    a[key] = after[key];
  }
  return { before: b, after: a };
}
