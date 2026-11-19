// OxioParty: las pestañas y lo que se pide de cada rol. En una fiesta no hay
// chicas ni sus ganancias, ni cola del datáfono: quedan Cobrar (la barra),
// Taquilla (la recepción de siempre, para quien carga pulseras), Cobros y
// Ajustes. Funciones puras: el Dashboard las aplica solo si isParty().

import type { RoleAccess, TabKey } from './roles';

/** El orden de la barra de abajo en OxioParty. */
const PARTY_ORDER: readonly TabKey[] = ['home', 'reception', 'payments', 'settings'];

/**
 * Las pestañas de OxioParty a partir de las del rol (ya filtradas por el
 * local): sin Ganancias ni POS, con Ajustes al final y en el orden de la fiesta.
 */
export function partyTabs(tabs: readonly TabKey[]): TabKey[] {
  const kept = new Set<TabKey>([...tabs.filter((t) => t !== 'earnings' && t !== 'pos'), 'settings']);
  return PARTY_ORDER.filter((t) => kept.has(t));
}

/**
 * Lo que se pide en OxioParty: ni el saldo, la noche ni las invitaciones de la
 * chica (/operators/me/*, /nights/mine), ni la cola del datáfono.
 */
export function partyAccess(access: RoleAccess): RoleAccess {
  return { ...access, tabs: partyTabs(access.tabs), ownEarnings: false, posQueue: false };
}

/** Lo que ve el rol en esta edición: en OxioPay, lo de siempre (el mismo objeto); en OxioParty, partyAccess. */
export function editionAccess(access: RoleAccess, party: boolean): RoleAccess {
  return party ? partyAccess(access) : access;
}

/** Cómo se llama cada pestaña en OxioParty («Recepción» es la Taquilla). */
export const PARTY_TAB_LABEL: Readonly<Record<TabKey, string>> = {
  home: 'Cobrar',
  reception: 'Taquilla',
  reservas: 'Reservados',
  pos: 'POS',
  payments: 'Cobros',
  earnings: 'Ganancias',
  settings: 'Ajustes',
};
