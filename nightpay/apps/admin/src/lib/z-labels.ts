// Nombres de las líneas «por tipo» del Z (Noches). Sin React: se prueba solo
// (z-labels.test.ts).

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
 * Lo que queda del neto quitando lo del personal. Es el Z (la caja): lleva las
 * recargas (saldo de los clientes, no ventas) y no resta las comisiones. No es
 * «Para el local» del mapa del dinero, que reparte lo vendido. Los Z congelados
 * antes de separar a los camareros no traen `camareroNetCents`: su cifra solo
 * restaba lo de las chicas, y así se dice.
 */
export function zNetLabel(summary: { camareroNetCents?: number }): string {
  return summary.camareroNetCents === undefined ? 'Neto sin las chicas' : 'Neto sin el personal';
}
