// «Te han invitado · +10 €» en la app de la chica: se ve cuando su noche trae
// más invitaciones que la vez anterior (el sondeo de «Mi noche»). La primera
// lectura no avisa (son las de antes). Función pura.

export interface InvitationsTonight {
  count: number;
  shareCents: number;
}

/** Lo que se lleva de las invitaciones nuevas (null: ninguna nueva o primera lectura). */
export function invitationArrived(
  before: InvitationsTonight | null | undefined,
  now: InvitationsTonight | null | undefined,
): number | null {
  if (!before || !now) return null;
  if (now.count <= before.count) return null;
  const cents = now.shareCents - before.shareCents;
  return cents > 0 ? cents : null;
}
