/**
 * Registro de la API de socios (audit_events). Lo que cambia una clave o una
 * conexión va con AuditService.logInTx en su misma transacción: sin registro
 * no hay cambio, y de él sale el aviso al dueño (incidents/incident-rules.ts,
 * SENSITIVE_ACTIONS). Nunca la clave, el token del enlace ni la sellada.
 */
export const PARTNER_AUDIT = {
  keyCreated: 'partner.key.created',
  keyRotated: 'partner.key.rotated',
  keyRevoked: 'partner.key.revoked',
  /** El correo con el enlace no salió: la conexión nueva se borra o la clave de antes vuelve. */
  keyIssueUndone: 'partner.key.issue_undone',
  keyExposed: 'partner.key.exposed',
  keySuspended: 'partner.key.suspended',
  keyExpiring: 'partner.key.expiring',
  claimOpened: 'partner.key.claim_opened',
  claimReopened: 'partner.key.claim_reopened',
  claimExpired: 'partner.key.claim_expired',
  connectionPaused: 'partner.connection.paused',
  connectionResumed: 'partner.connection.resumed',
  foreignIp: 'partner.foreign_ip',
  apiFrozen: 'partner.api_frozen',
  apiUnfrozen: 'partner.api_unfrozen',
} as const;

export interface PartnerAuditSubject {
  id: string;
  keyHint: string;
  scopes: readonly string[];
  partner: { name: string };
}

/** `{ connectionId, keyHint, name, scopes }`: lo único que va en el registro de una conexión. */
export function partnerAuditPayload(c: PartnerAuditSubject, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { connectionId: c.id, keyHint: c.keyHint, name: c.partner.name, scopes: [...c.scopes], ...extra };
}
