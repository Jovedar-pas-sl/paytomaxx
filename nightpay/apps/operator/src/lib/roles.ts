import type { OperatorUser } from './api';

export type StaffRole = OperatorUser['role'];
export type TabKey = 'home' | 'wallet' | 'reception' | 'pos' | 'payments' | 'earnings';

export interface RoleAccess {
  /** Pestañas de abajo, en orden. */
  tabs: readonly TabKey[];
  /** Su saldo, su noche, sus comisiones y liquidaciones (/operators/me/balance|earnings|payouts, /nights/mine). */
  ownEarnings: boolean;
  /** Historial propio de los cobros que ha creado. */
  ownPayments: boolean;
  /** Cobros con datáfono que esperan que alguien los confirme (/payments/pending-pos). */
  posQueue: boolean;
}

/**
 * Lo que ve cada rol. /operators/me/* y /nights/mine son solo de la chica
 * (OPERATOR): al camarero, al encargado o al dueño el API les da 403, así que
 * ni se piden. Su historial usa /staff/me/cobros. Ellos confirman los cobros con datáfono que crean las chicas.
 */
const OPERATOR_ACCESS: RoleAccess = {
  tabs: ['home', 'wallet', 'payments', 'earnings'],
  ownEarnings: true,
  ownPayments: true,
  posQueue: false,
};

/** Camarero, encargado y dueño: además, la recepción (recargar saldo, ficha y PIN; preparar fichas). */
const STAFF_ACCESS: RoleAccess = {
  tabs: ['home', 'wallet', 'payments', 'reception', 'pos'],
  ownEarnings: false,
  ownPayments: true,
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
