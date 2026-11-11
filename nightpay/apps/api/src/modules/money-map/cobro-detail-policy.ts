import {
  firstNameOf,
  type CobroDetail,
  type CobroDetailBank,
  type CobroDetailCardMore,
  type CobroDetailDevice,
  type CobroDetailHistoryItem,
  type CobroDetailMine,
  type CobroDetailSplit,
  type CobroDetailStaffShare,
  type CobroFlag,
  type StepUpMethod,
} from '@nightpay/contracts';

/**
 * Qué ve cada uno del detalle de un cobro (lógica pura). El servicio junta
 * TODO lo que se sabe del cobro (CobroDetailFacts) y esto decide qué sale:
 *
 *  - Cliente (/w): lo básico y el saldo antes y después. Nunca quién anuló ni
 *    por qué (es texto interno), ni señales, ni nada delicado. Quien le cobró,
 *    solo por su nombre de pila.
 *  - Personal (la chica, el camarero): lo básico y «lo tuyo» (solo lo suyo:
 *    nunca la parte del local, de OxioPay ni de otras personas). Con la
 *    verificación del momento, el historial y su propio dispositivo.
 *  - Encargado y dueño: lo básico, lo del banco y las señales; el reparto
 *    entero, el dueño siempre y el encargado con el permiso «Informes». Con la
 *    verificación del momento, todos los dispositivos (también el del
 *    cliente) con su IP, la tarjeta más allá de los últimos 4 y el historial.
 */

export type CobroViewer =
  | { audience: 'CLIENT' }
  | { audience: 'STAFF'; userId: string }
  | { audience: 'MANAGER'; userId: string; role: 'OWNER' | 'MANAGER'; canSeeSplit: boolean };

/** Un dispositivo con quién era (para quedarse con los suyos al personal). */
export interface DeviceFact extends CobroDetailDevice {
  userId: string | null;
}

/** Todo lo que se sabe del cobro, antes de recortarlo para quien lo mira. */
export interface CobroDetailFacts {
  base: Omit<CobroDetail, 'audience' | 'chargedBy' | 'flags' | 'balance' | 'mine' | 'split' | 'bank' | 'panelUrl' | 'sensitive' | 'verify'>;
  /** Quién cobró: su nombre visible (o el email, sin nombre) y su nombre de pila. */
  chargedBy: { name: string; displayName: string | null; role: string | null } | null;
  flags: CobroFlag[];
  balance: { beforeCents: number; afterCents: number } | null;
  shares: CobroDetailStaffShare[];
  /** Null en las recargas (no son venta). */
  split: CobroDetailSplit | null;
  /** Null en los cobros del saldo. */
  bank: CobroDetailBank | null;
  panelUrl: string | null;
  devices: DeviceFact[];
  card: CobroDetailCardMore | null;
  history: CobroDetailHistoryItem[];
}

/** Las señales de cada uno. */
const STAFF_FLAGS: ReadonlySet<CobroFlag> = new Set(['PAID_TWICE', 'FROM_HOME', 'NFC_NO_PIN', 'APPROVED_BY_STAFF']);

/** Lo de la verificación del momento de quien mira. */
export interface DetailVerification {
  /** Hasta cuándo vale (null: sin verificar o caducada). */
  verifiedUntil: string | null;
  /** Con qué tiene que verificarse (null: no tiene ninguna forma: que active la 2FA o su llave). */
  method: StepUpMethod | null;
}

/** El detalle que ve `viewer` (nunca más de lo suyo). */
export function shapeCobroDetail(facts: CobroDetailFacts, viewer: CobroViewer, verification: DetailVerification | null): CobroDetail {
  if (viewer.audience === 'CLIENT') {
    return {
      audience: 'CLIENT',
      ...facts.base,
      // Quién y por qué es texto interno: el cliente ve qué pasó y cuándo.
      undo: facts.base.undo.map((u) => ({ ...u, by: null, reason: null })),
      chargedBy: facts.chargedBy ? { name: firstNameOf(facts.chargedBy.displayName), role: null } : null,
      flags: [],
      balance: facts.balance,
    };
  }
  const verified = Boolean(verification?.verifiedUntil);
  const verify = {
    required: !verified,
    method: verification?.method ?? null,
    verifiedUntil: verification?.verifiedUntil ?? null,
  };
  const chargedBy = facts.chargedBy ? { name: facts.chargedBy.name, role: facts.chargedBy.role } : null;
  if (viewer.audience === 'STAFF') {
    return {
      audience: 'STAFF',
      ...facts.base,
      chargedBy,
      flags: facts.flags.filter((f) => STAFF_FLAGS.has(f)),
      mine: mineOf(facts.shares, viewer.userId),
      panelUrl: facts.panelUrl,
      sensitive: verified
        ? {
            // Solo su propio dispositivo: nunca el del cliente ni el de otras personas.
            devices: facts.devices.filter((d) => d.who === 'staff' && d.userId === viewer.userId).map(publicDevice),
            card: null,
            history: facts.history,
          }
        : null,
      verify,
    };
  }
  return {
    audience: 'MANAGER',
    ...facts.base,
    chargedBy,
    flags: facts.flags,
    ...(viewer.canSeeSplit ? { split: facts.split } : {}),
    bank: facts.bank,
    panelUrl: facts.panelUrl,
    sensitive: verified ? { devices: facts.devices.map(publicDevice), card: facts.card, history: facts.history } : null,
    verify,
  };
}

/** Lo de esta persona en el cobro (null: no le da nada). */
export function mineOf(shares: readonly CobroDetailStaffShare[], userId: string): CobroDetailMine | null {
  const s = shares.find((x) => x.personId === userId);
  if (!s) return null;
  return {
    commissionCents: s.commissionCents,
    tipCents: s.tipCents,
    invitationCents: s.invitationCents,
    reversedCents: s.reversedCents,
    totalCents: s.totalCents,
  };
}

function publicDevice(d: DeviceFact): CobroDetailDevice {
  const { userId: _userId, ...rest } = d;
  return rest;
}
