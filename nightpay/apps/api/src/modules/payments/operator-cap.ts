/**
 * Tope del local para los cobros que crea la chica (Venue.operatorMaxCobroCents).
 * Cuenta importe + propina: si no, una propina inventada se saltaba el tope.
 *  - Recarga de saldo: el cliente decide cuánto carga, sin tope.
 *  - Servicio de la carta: el importe lo fija el local; cuenta solo la propina.
 *  - Dueño, encargado y camarero: sin tope.
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
  if (args.creatorRole !== 'OPERATOR' || args.isWalletTopUp) return null;
  const totalCents = (args.fromMenu ? 0 : args.amountCents) + args.tipCents;
  if (totalCents <= args.capCents) return null;
  const withTip = args.tipCents > 0 ? ' (con propina)' : '';
  return (
    `Importe ${eur(totalCents)}${withTip} supera el límite del local (${eur(args.capCents)}). ` +
    `Para wallet top-up no aplica el cap; para cobros puntuales pídele al OWNER que suba el cap en Ajustes.`
  );
}

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2)} €`;
}
