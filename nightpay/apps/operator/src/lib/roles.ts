import type { OperatorUser } from './api';

export type StaffRole = OperatorUser['role'];
/**
 * Pestañas de abajo. Ya no hay «Saldo» (wallet): Inicio es la única pantalla
 * de cobrar (el QR, la ficha NFC y, discreto, su código o su pase con su PIN).
 * «Ajustes» (settings) solo sale en OxioParty (lib/party-tabs).
 */
export type TabKey = 'home' | 'reception' | 'pos' | 'payments' | 'earnings' | 'settings';

/**
 * «Cobros»: la lista de /staff/me/cobros (la del panel: un cobro = una fila,
 * el cobro único pagado con el saldo como pagado con saldo) para todos. Si
 * deja cancelar ahí los cobros con tarjeta aún sin pagar y cada cuánto se
 * refresca.
 */
export interface OwnHistory {
  cancelPending: boolean;
  pollMs: number;
}

export interface RoleAccess {
  /** Pestañas de abajo, en orden. */
  tabs: readonly TabKey[];
  /** Su saldo, su noche, sus comisiones y liquidaciones (/operators/me/balance|earnings|payouts, /nights/mine). */
  ownEarnings: boolean;
  /** Historial propio de los cobros que ha creado. */
  ownPayments: boolean;
  /** Cómo es ese historial. */
  history: OwnHistory;
  /** Cobros con datáfono que esperan que alguien los confirme (/payments/pending-pos). */
  posQueue: boolean;
}

/**
 * Lo que ve cada rol. /operators/me/* y /nights/mine son solo de la chica
 * (OPERATOR): al camarero, al encargado o al dueño el API les da 403, así que
 * ni se piden. El historial de todos usa /staff/me/cobros. Ellos confirman los
 * cobros con datáfono que crean las chicas. La chica, en «Cobros», cancela
 * sus cobros sin pagar y lo ve al día cada 5 s, como en su lista de antes.
 */
const OPERATOR_ACCESS: RoleAccess = {
  tabs: ['home', 'payments', 'earnings'],
  ownEarnings: true,
  ownPayments: true,
  history: { cancelPending: true, pollMs: 5000 },
  posQueue: false,
};

/** Camarero, encargado y dueño: además, la recepción (recargar saldo, ficha y PIN; preparar fichas). */
const STAFF_ACCESS: RoleAccess = {
  tabs: ['home', 'payments', 'reception', 'pos'],
  ownEarnings: false,
  ownPayments: true,
  history: { cancelPending: false, pollMs: 15_000 },
  posQueue: true,
};

export function roleAccess(role: StaffRole): RoleAccess {
  return role === 'OPERATOR' ? OPERATOR_ACCESS : STAFF_ACCESS;
}

export function canOpenTab(role: StaffRole, tab: TabKey): boolean {
  return roleAccess(role).tabs.includes(tab);
}

/** Cómo se dice cada rol en la pantalla de inicio. */
export const ROLE_LABEL: Record<StaffRole, string> = {
  OPERATOR: 'Operadora',
  WAITER: 'Camarero',
  MANAGER: 'Encargado',
  OWNER: 'Dueño',
};
