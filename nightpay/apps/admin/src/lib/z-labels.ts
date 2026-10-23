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
