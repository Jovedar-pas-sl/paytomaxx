// «Te han invitado · +10 €» y «Servicio cobrado · +54 €» en la app de la
// compañera: se ve cuando su noche trae más invitaciones (o más servicios que
// otra persona le cobró a su nombre) que la vez anterior (el sondeo de «Mi
// noche»). La primera lectura no avisa (son las de antes). Lo visto de los
// servicios se guarda en el móvil: así avisa también de lo cobrado con la app
// cerrada.

export interface InvitationsTonight {
  count: number;
  shareCents: number;
}

/** Lo último visto de sus servicios cobrados por otra persona, con la noche («from» de «Mi noche»). */
export interface ServedSeen extends InvitationsTonight {
  from: string;
}

/** Lo que se lleva de las invitaciones (o servicios) nuevas (null: ninguna nueva o primera lectura). */
export function invitationArrived(
  before: InvitationsTonight | null | undefined,
  now: InvitationsTonight | null | undefined,
): number | null {
  if (!before || !now) return null;
  if (now.count <= before.count) return null;
  const cents = now.shareCents - before.shareCents;
  return cents > 0 ? cents : null;
}

/**
 * Desde dónde se cuentan los servicios nuevos: lo visto en esta misma noche
 * (aunque la app se cerrara entre medias). De otra noche, o algo guardado que
 * no tiene la forma, nada: es la primera lectura.
 */
export function servedBaseline(seen: unknown, night: { from: string }): InvitationsTonight | null {
  if (!seen || typeof seen !== 'object') return null;
  const s = seen as Partial<ServedSeen>;
  if (s.from !== night.from || !Number.isFinite(s.count) || !Number.isFinite(s.shareCents)) return null;
  return { count: s.count as number, shareCents: s.shareCents as number };
}

const servedKey = (userId: string) => `np_served_seen:${userId}`;

/** Lo visto guardado en este móvil (null: nada, o sin almacenamiento, como en navegación privada). */
export function loadServedSeen(userId: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(servedKey(userId)) ?? 'null');
  } catch {
    return null;
  }
}

export function saveServedSeen(userId: string, seen: ServedSeen): void {
  try {
    localStorage.setItem(servedKey(userId), JSON.stringify(seen));
  } catch {
    // Sin almacenamiento: el aviso sale igual mientras la app esté abierta.
  }
}
