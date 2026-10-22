/**
 * Quién cobra comisión y se le paga desde el panel: las chicas y los
 * camareros (su parte de las invitaciones, «Copa con invitación»). Mismo pago,
 * mismas aprobaciones y la misma 2FA. Lo demás (alta, contraseña, enlace,
 * datos) sigue siendo solo de las chicas.
 */
export const PAYEE_ROLES = ['OPERATOR', 'WAITER'] as const;
export type PayeeRole = (typeof PAYEE_ROLES)[number];

export function isPayeeRole(value: unknown): value is PayeeRole {
  return typeof value === 'string' && (PAYEE_ROLES as readonly string[]).includes(value);
}
