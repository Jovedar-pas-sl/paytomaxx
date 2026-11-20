'use client';

import { useCallback, useEffect, useState } from 'react';
import { defaultTabOf, navRequestFor, navSearch, parseNav, resolveNav, type NavRequest } from './nav-url';
import { sectionOf, type PanelSection, type TabKey } from './roles';

/** push: el dueño cambió de pestaña («atrás» vuelve a la de antes). replace: se corrige sin dejar rastro. */
export type HistoryMode = 'push' | 'replace';

/** Escribe la pestaña en la URL (nada si ya está). Con `null`, Next guarda su estado en la entrada nueva. */
export function writeNavToUrl(tab: TabKey, mode: HistoryMode): void {
  if (typeof window === 'undefined') return;
  const { pathname, search, hash } = window.location;
  const next = navSearch(search, tab);
  if (next === search) return;
  const url = `${pathname}${next}${hash}`;
  if (mode === 'push') window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}

/** Al salir: la URL limpia, quien entre después empieza en Hoy (en OxioParty, En directo). */
export function clearNavFromUrl(): void {
  writeNavToUrl(defaultTabOf(), 'replace');
}

interface Visibility {
  /** Lo que vería si llegan los permisos y las formas de cobro que faltan (todo a favor). */
  permissive: readonly PanelSection[];
  /** Ya se sabe lo que ve (permisos del encargado y datáfono del local). */
  settled: boolean;
}

/**
 * La pestaña del panel, guardada en la URL. Una que este rol o este local no
 * tienen se cambia por Hoy sin decir nada; pero mientras no han llegado los
 * permisos o las formas de cobro, una que aún podría salir se espera (no se
 * borra de la URL antes de tiempo). Devuelve la pestaña y cómo ir a otra.
 */
export function useUrlNav(
  sections: readonly PanelSection[],
  { permissive, settled }: Visibility,
): [TabKey, (tab: TabKey) => void] {
  const [requested, setRequested] = useState<NavRequest>(() =>
    typeof window === 'undefined' ? navRequestFor(defaultTabOf()) : parseNav(window.location.search),
  );
  const tab = resolveNav(requested, sections);
  const waiting = !settled && resolveNav(requested, permissive) !== tab;

  // «Atrás» y «adelante»: a la pestaña que diga la URL.
  useEffect(() => {
    function onPopState(): void {
      setRequested(parseNav(window.location.search));
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Lo pedido no se puede enseñar, o la URL no estaba escrita como toca: la URL dice lo que se ve.
  useEffect(() => {
    if (waiting) return;
    if (requested.tab !== tab || requested.section !== sectionOf(tab)) setRequested(navRequestFor(tab));
    writeNavToUrl(tab, 'replace');
  }, [requested, tab, waiting]);

  const navigate = useCallback((next: TabKey) => {
    writeNavToUrl(next, 'push');
    setRequested(navRequestFor(next));
  }, []);

  return [tab, navigate];
}
