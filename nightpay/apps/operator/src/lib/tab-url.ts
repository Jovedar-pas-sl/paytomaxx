// La pestaña de abajo vive en la URL (?t=cobros): recargar la página, o volver
// a entrar tras caducar la sesión, deja a la chica donde estaba, y el botón
// «atrás» del móvil vuelve a la pestaña de antes. Inicio no lleva nada (la URL
// limpia de siempre). Solo el nombre de la pestaña: nunca ids ni secretos.
// Los otros parámetros (?pos=, ?ficha=) no se tocan.

import type { TabKey } from './roles';

export const TAB_PARAM = 't';

export const HOME_TAB: TabKey = 'home';

/** Cómo se escribe cada pestaña en la URL (en castellano, como la barra). */
const TAB_SLUG: Readonly<Record<TabKey, string>> = {
  home: 'inicio',
  reception: 'recepcion',
  reservas: 'reservados',
  pos: 'pos',
  payments: 'cobros',
  earnings: 'ganancias',
  // Solo en OxioParty: en OxioPay no se ve y su enlace lleva a Inicio (resolveTab).
  settings: 'ajustes',
};

/**
 * Pestañas que ya no existen y adónde llevan sus enlaces guardados (una
 * pestaña abierta, un favorito, «atrás»): «Saldo» (?t=saldo) cobraba lo mismo
 * que Inicio, que ahora es la única pantalla de cobrar.
 */
const RETIRED_SLUGS: ReadonlyMap<string, TabKey> = new Map([['saldo', HOME_TAB]]);

const SLUG_TAB: ReadonlyMap<string, TabKey> = new Map([
  ...(Object.entries(TAB_SLUG) as Array<[TabKey, string]>).map(([tab, slug]) => [slug, tab] as const),
  ...RETIRED_SLUGS,
]);

/** La pestaña que pide la URL (`?t=cobros`; `?t=saldo`, Inicio); null si no pide ninguna o no existe. */
export function parseTab(search: string): TabKey | null {
  const slug = new URLSearchParams(search).get(TAB_PARAM);
  return slug === null ? null : (SLUG_TAB.get(slug.trim().toLowerCase()) ?? null);
}

/** La pestaña que se enseña: la pedida si este rol y este local la tienen; si no, Inicio. */
export function resolveTab(requested: TabKey | null, visible: readonly TabKey[]): TabKey {
  return requested !== null && visible.includes(requested) ? requested : HOME_TAB;
}

/**
 * La query con esa pestaña (`?t=cobros`), sin tocar los otros parámetros.
 * Inicio la quita. Devuelve '' o '?…', listo para la URL.
 */
export function tabSearch(search: string, tab: TabKey): string {
  const params = new URLSearchParams(search);
  if (tab === HOME_TAB) params.delete(TAB_PARAM);
  else params.set(TAB_PARAM, TAB_SLUG[tab]);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** La query sin la pestaña (al salir, o si entra otra persona): se empieza en Inicio. */
export function withoutTab(search: string): string {
  return tabSearch(search, HOME_TAB);
}
