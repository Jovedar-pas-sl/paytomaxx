/**
 * Quién tiene el tope del local en «Otro importe» (Venue.operatorMaxCobroCents):
 * la compañera y, desde el 19-11-2026 (decisión del dueño), también el camarero
 * y el encargado, con el mismo tope. El dueño, sin tope.
 */
export const CAPPED_ROLES: ReadonlySet<string> = new Set(['OPERATOR', 'WAITER', 'MANAGER']);

/**
 * Tope del local para los cobros que crea el personal (Venue.operatorMaxCobroCents).
 * Cuenta importe + propina: si no, una propina inventada se saltaba el tope.
 *  - Recarga de saldo: el cliente decide cuánto carga, sin tope.
 *  - Servicio de la carta: el importe lo fija el local; cuenta solo la propina.
 *  - Dueño y cobros sin persona (reservados, el cliente): sin tope.
 * Devuelve el mensaje del 400 o null si cabe.
 */
export function operatorCapProblem(args: {
  creatorRole: string | null | undefined;
  isWalletTopUp: boolean;
  fromMenu: boolean;
  amountCents: number;
  tipCents: number;
  capCents: number;
}): string | null {
  if (!args.creatorRole || !CAPPED_ROLES.has(args.creatorRole) || args.isWalletTopUp) return null;
  const totalCents = (args.fromMenu ? 0 : args.amountCents) + args.tipCents;
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
