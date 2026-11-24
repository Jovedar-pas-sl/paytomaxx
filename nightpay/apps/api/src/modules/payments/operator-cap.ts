import { isPartyEdition } from '../../config/edition';

/**
 * Quién tiene el tope del local en «Otro importe» (Venue.operatorMaxCobroCents):
 * la compañera y, desde el 19-11-2026 (decisión del dueño), también el camarero
 * y el encargado, con el mismo tope. El dueño, sin tope.
 */
const CAPPED_ROLES: ReadonlySet<string> = new Set(['OPERATOR', 'WAITER', 'MANAGER']);

/** Con EDITION=party, solo el personal (como en main): el panel de OxioParty no tiene «Reglas del local» para cambiar el tope. */
export function hasCobroCap(role: string | null | undefined): boolean {
  if (!role || !CAPPED_ROLES.has(role)) return false;
  return role === 'OPERATOR' || !isPartyEdition();
}

/**
 * Tope del local para los cobros que crea el personal (Venue.operatorMaxCobroCents).
 * Cuenta lo tecleado + propina: si no, una propina inventada se saltaba el tope.
 *  - Recarga de saldo: el cliente decide cuánto carga, sin tope.
 *  - La carta: el importe lo fija el local; no cuenta, tampoco en una cuenta mixta (carta + «Otro importe»).
 *  - Dueño y cobros sin persona (reservados, el cliente): sin tope.
 * Devuelve el mensaje del 400 o null si cabe.
 */
export function operatorCapProblem(args: {
  creatorRole: string | null | undefined;
  isWalletTopUp: boolean;
  /** Lo tecleado a mano («Otro importe»), sin la carta (ResolvedCharge.typedCents). */
  typedCents: number;
  tipCents: number;
  capCents: number;
}): string | null {
  if (!hasCobroCap(args.creatorRole) || args.isWalletTopUp) return null;
  const totalCents = args.typedCents + args.tipCents;
  if (totalCents <= args.capCents) return null;
  const withTip = args.tipCents > 0 ? ' (con propina)' : '';
  return (
    `Importe ${eur(totalCents)}${withTip} supera el límite del local (${eur(args.capCents)}). ` +
    'Las recargas de saldo no tienen límite; para cobros puntuales pídele al dueño que lo suba en Ajustes.'
  );
}

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2)} €`;
}
