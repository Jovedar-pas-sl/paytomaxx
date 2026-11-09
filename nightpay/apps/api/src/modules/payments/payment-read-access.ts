/**
 * Quién puede leer un cobro del local: el dueño y el encargado, todos; el
 * resto del personal (la chica, el camarero), solo los que ha hecho él o
 * ella. Uno de otra persona, como si no existiera (404, nunca 403: no se dice
 * si existe). Lo usan el detalle del pago y los endpoints antiguos
 * GET /v1/payments/:id y GET /v1/payments/:id/refunds.
 */
const VENUE_WIDE_ROLES: ReadonlySet<string> = new Set(['OWNER', 'MANAGER']);

export function seesWholeVenue(role: string | undefined): boolean {
  return role !== undefined && VENUE_WIDE_ROLES.has(role);
}

export function mayReadCobro(actor: { userId: string; role: string }, createdByUserId: string | null | undefined): boolean {
  return seesWholeVenue(actor.role) || (Boolean(createdByUserId) && createdByUserId === actor.userId);
}
