'use client';

import { useEffect, useRef, useState } from 'react';
import type { OwnHistoryPage } from '@nightpay/contracts';
import { appendPage, historyParams, type DayRange } from '@/lib/history';

export interface HistoryState<T> {
  /** null: cargando la primera página. */
  items: T[] | null;
  /** Quedan más antiguas («Ver anteriores»). */
  cursor: string | null;
  error: string | null;
  moreBusy: boolean;
}

const START: HistoryState<never> = { items: null, cursor: null, error: null, moreBusy: false };

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'No se pudo cargar. Vuelve a intentarlo.');

/**
 * Una lista por páginas entre dos fechas: la primera al entrar y cada vez
 * que cambian las fechas (lo que llegue de antes ya no se pinta); `more`
 * añade la siguiente. `load` es una función fija (de lib/api.ts).
 */
export function useHistory<T extends { id: string }>(
  load: (query: URLSearchParams) => Promise<OwnHistoryPage<T>>,
  days: DayRange,
): HistoryState<T> & { more: () => void } {
  const [state, setState] = useState<HistoryState<T>>(START);
  const round = useRef(0);
  const { fromDay, toDay } = days;

  useEffect(() => {
    const mine = ++round.current;
    setState(START);
    load(historyParams({ fromDay, toDay })).then(
      (page) => {
        if (round.current === mine) setState({ items: page.items, cursor: page.nextCursor, error: null, moreBusy: false });
      },
      (err: unknown) => {
        if (round.current === mine) setState({ items: [], cursor: null, error: errorText(err), moreBusy: false });
      },
    );
  }, [load, fromDay, toDay]);

  function more(): void {
    if (!state.cursor || state.moreBusy) return;
    const mine = round.current;
    setState((s) => ({ ...s, moreBusy: true }));
    load(historyParams({ fromDay, toDay }, state.cursor)).then(
      (page) => {
        if (round.current === mine) setState((s) => ({ items: appendPage(s.items ?? [], page.items), cursor: page.nextCursor, error: null, moreBusy: false }));
      },
      (err: unknown) => {
        if (round.current === mine) setState((s) => ({ ...s, error: errorText(err), moreBusy: false }));
      },
    );
  }

  return { ...state, more };
}
