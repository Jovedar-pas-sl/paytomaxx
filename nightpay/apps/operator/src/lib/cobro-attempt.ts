// «Cobrar» (CobrarFlow), lógica pura: un cobro de «Copa con invitación» que
// llega cuando quien cobra ya se ha ido de su pantalla (pulsó «Atrás» mientras
// se creaba) no abre «Esperando» y se cancela: ni una pantalla que salta sola
// ni un cobro pendiente que nadie ve.

/** Lo que se pidió: si es una invitación y en qué pantalla (cada cambio de pantalla, una más). */
export interface CobroAttempt {
  invitation: boolean;
  screen: number;
}

/** ¿Se descarta lo que llega? Solo una invitación pedida en una pantalla de la que ya se salió. */
export function arrivedTooLate(attempt: CobroAttempt, currentScreen: number): boolean {
  return attempt.invitation && attempt.screen !== currentScreen;
}

/** Cómo se cancela un cobro ya creado: el de tarjeta (cancela también su saldo enlazado) o, sin tarjeta, el del saldo. */
export function cancelTargetOf(cobro: {
  card: { id: string } | null;
  saldo: { chargeId: string } | null;
}): { kind: 'card' | 'saldo'; id: string } | null {
  if (cobro.card) return { kind: 'card', id: cobro.card.id };
  if (cobro.saldo) return { kind: 'saldo', id: cobro.saldo.chargeId };
  return null;
}
