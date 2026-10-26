// Nombres de las líneas «por tipo» del Z (Noches). Sin React: se prueba solo
// (z-labels.test.ts).

import { Z_NET_LABEL, Z_NET_WITHOUT_STAFF_LABEL } from '@nightpay/contracts';

/** «Neto (cobrado − devuelto)»: el otro neto del Z (`netCents`), distinto de zNetLabel. */
export { Z_NET_LABEL };

/**
 * Los Z de las noches cerradas se guardan congelados con los nombres de
 * entonces. Los de antes de dejar de decir «wallet» al usuario traen
 * «Recarga de wallet»: al pintarlos, el nombre de ahora.
 */
const RENAMED: Readonly<Record<string, string>> = {
  'Recarga de wallet': 'Recarga con tarjeta',
};

export function zTypeLabel(label: string): string {
  return RENAMED[label] ?? label;
}

/**
 * Lo que queda del neto quitando lo del personal (como en el resumen de las
 * 9:00). Es el Z (la caja): lleva las recargas (saldo de los clientes, no
 * ventas) y no resta las comisiones. No es «Para el local» del mapa del
 * dinero, que reparte lo vendido. Los Z congelados antes de separar a los
 * camareros no traen `camareroNetCents`: su cifra solo restaba lo de las
 * chicas, y así se dice.
 */
export function zNetLabel(summary: { camareroNetCents?: number }): string {
  return summary.camareroNetCents === undefined ? 'Neto sin las chicas' : Z_NET_WITHOUT_STAFF_LABEL;
}
