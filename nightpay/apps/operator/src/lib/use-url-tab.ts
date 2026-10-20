'use client';

import { useCallback, useEffect, useState } from 'react';
import type { TabKey } from './roles';
import { HOME_TAB, parseTab, resolveTab, tabSearch } from './tab-url';

/** push: la chica cambió de pestaña («atrás» vuelve a la de antes). replace: se corrige sin dejar rastro. */
export type HistoryMode = 'push' | 'replace';

/** Escribe la pestaña en la URL (nada si ya está). Con `null`, Next guarda su estado en la entrada nueva. */
export function writeTabToUrl(tab: TabKey, mode: HistoryMode): void {
  if (typeof window === 'undefined') return;
  const { pathname, search, hash } = window.location;
  const next = tabSearch(search, tab);
  if (next === search) return;
  const url = `${pathname}${next}${hash}`;
  if (mode === 'push') window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}

/** Al salir (o si entra otra persona): la URL sin pestaña, quien entre empieza en Inicio. */
export function clearTabFromUrl(): void {
  writeTabToUrl(HOME_TAB, 'replace');
}

/**
 * La pestaña de abajo, guardada en la URL. `visible`: las que tiene este rol
 * en este local; una que no está (otro rol, o apagada por el dueño) se
 * cambia por Inicio sin decir nada. Devuelve la pestaña y cómo cambiarla.
 */
export function useUrlTab(visible: readonly TabKey[]): [TabKey, (tab: TabKey, mode?: HistoryMode) => void] {
  const [requested, setRequested] = useState<TabKey>(() =>
    typeof window === 'undefined' ? HOME_TAB : (parseTab(window.location.search) ?? HOME_TAB),
  );
  const tab = resolveTab(requested, visible);

  // «Atrás» y «adelante» del móvil: a la pestaña que diga la URL.
  useEffect(() => {
    function onPopState(): void {
      setRequested(parseTab(window.location.search) ?? HOME_TAB);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Lo pedido no se puede enseñar (o la URL traía otra cosa): la URL dice lo que se ve.
  useEffect(() => {
    if (requested !== tab) setRequested(tab);
    writeTabToUrl(tab, 'replace');
  }, [requested, tab]);

  const select = useCallback((next: TabKey, mode: HistoryMode = 'push') => {
    writeTabToUrl(next, mode);
    setRequested(next);
  }, []);

  return [tab, select];
}
