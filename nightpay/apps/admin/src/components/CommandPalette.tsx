'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Sheet } from '@nightpay/ui';
import type { CobroRow, WalletCardRow } from '@nightpay/contracts';
import { fetchCobros, fetchCurrentNight, fetchOperators, lookupWalletCode, type Operator } from '@/lib/api';
import {
  accionesDe,
  filaCobro,
  filaFicha,
  pantallasDe,
  PALETTE_LIMIT,
  personasDe,
  queBuscar,
  type Destino,
} from '@/lib/command-palette';
import { fetchFichas } from '@/lib/endpoints/fichas';
import type { PanelSection } from '@/lib/roles';
import { useVenueTimezone } from '@/lib/venue-context';
import { useFichas } from './fichas/fichas-context';

/** Lo escrito espera un poco antes de buscar cobros y fichas. */
const DEBOUNCE_MS = 250;
const LIST_ID = 'np-cmdk-list';

type Group = 'Pantallas' | 'Acciones' | 'Cobros' | 'Personas' | 'Fichas';
type Remote<T> = { state: 'idle' } | { state: 'loading' } | { state: 'ok'; items: T[] } | { state: 'error' };

interface Option {
  group: Group;
  key: string;
  label: string;
  detail?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Lo que ve este rol (visibleSections): no se enseña nada más. */
  sections: readonly PanelSection[];
  isOwner: boolean;
  /** El dueño, o el encargado con «cerrar la noche». */
  canCloseNight: boolean;
  /** Ir a una pantalla (con su ventana abierta, si la acción lo dice). Solo navega. */
  onGo: (destino: Destino) => void;
  /** Cobros con el detalle de ese cobro (buscado por su referencia en todas las fechas). */
  onOpenRef: (ref: string) => void;
}

/**
 * Buscar y saltar (Ctrl+K o la lupa): pantallas, acciones, cobros, personas y
 * fichas, hasta 5 de cada. Solo lo que el rol ya ve, y solo navega: ninguna
 * fila hace nada con el dinero por sí misma. No se guarda lo buscado.
 */
export function CommandPalette({ open, onClose, sections, isOwner, canCloseNight, onGo, onOpenRef }: Props) {
  const tz = useVenueTimezone();
  const fichas = useFichas();
  const tabs = sections.flatMap((s) => s.tabs);
  const sees = (key: string) => tabs.some((t) => t.key === key);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [night, setNight] = useState<'open' | 'none' | 'unknown'>('unknown');
  const [people, setPeople] = useState<{ chicas: Operator[]; camareros: Operator[] } | 'error' | null>(null);
  const [cobros, setCobros] = useState<Remote<CobroRow>>({ state: 'idle' });
  const [cards, setCards] = useState<Remote<WalletCardRow>>({ state: 'idle' });
  const [opening, setOpening] = useState<'busy' | 'error' | null>(null);
  const search = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Al abrir: la noche (para «Cerrar noche» o «Abrir noche») y las personas. Nada de lo buscado queda.
  useEffect(() => {
    if (!open) return;
    setQ('');
    setActive(0);
    setOpening(null);
    setNight('unknown');
    let gone = false;
    fetchCurrentNight().then(
      (n) => !gone && setNight(n ? 'open' : 'none'),
      () => !gone && setNight('unknown'),
    );
    if (sees('operators')) {
      setPeople(null);
      Promise.all([fetchOperators(), fetchOperators('WAITER').catch(() => [] as Operator[])]).then(
        ([chicas, camareros]) => !gone && setPeople({ chicas, camareros }),
        () => !gone && setPeople('error'),
      );
    }
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      gone = true;
      search.current?.abort();
    };
    // Solo al abrir.
  }, [open]);

  // Cobros (desde 3 letras) y fichas (con cifras), a los 250 ms; cada búsqueda cancela la anterior.
  useEffect(() => {
    search.current?.abort();
    const want = queBuscar(q);
    const wantCobros = want.cobros !== null && sees('payments');
    const wantCards = want.ficha !== null && sees('fichas');
    setCobros(wantCobros ? { state: 'loading' } : { state: 'idle' });
    setCards(wantCards ? { state: 'loading' } : { state: 'idle' });
    if (!open || (!wantCobros && !wantCards)) return;
    const controller = new AbortController();
    search.current = controller;
    const timer = window.setTimeout(() => {
      if (wantCobros) {
        fetchCobros({ search: want.cobros! }, { limit: PALETTE_LIMIT }, controller.signal).then(
          (page) => !controller.signal.aborted && setCobros({ state: 'ok', items: page.items }),
          () => !controller.signal.aborted && setCobros({ state: 'error' }),
        );
      }
      if (wantCards) {
        fetchFichas({ q: want.ficha! }, controller.signal).then(
          (list) => !controller.signal.aborted && setCards({ state: 'ok', items: list }),
          () => !controller.signal.aborted && setCards({ state: 'error' }),
        );
      }
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [q, open]);

  function go(destino: Destino): void {
    onClose();
    onGo(destino);
  }

  /** La ficha: UNA consulta del saldo al elegirla (nunca al teclear: tiene tope por minuto). */
  async function openCard(card: WalletCardRow): Promise<void> {
    if (!card.walletCode || !fichas) {
      go({ tab: 'fichas' });
      return;
    }
    setOpening('busy');
    try {
      const wallet = await lookupWalletCode(card.walletCode);
      onClose();
      fichas.openWallet(wallet.walletId);
    } catch {
      setOpening('error');
    }
  }

  const options: Option[] = [];
  const notes: Partial<Record<Group, string>> = {};
  if (q.trim()) {
    for (const p of pantallasDe(sections, q)) options.push({ group: 'Pantallas', key: `p-${p.key}`, label: p.label, run: () => go({ tab: p.key }) });
  }
  for (const a of accionesDe({ tabs, isOwner, canCloseNight, night }, q)) {
    options.push({ group: 'Acciones', key: `a-${a.id}`, label: a.label, run: () => go(a.destino) });
  }
  if (cobros.state === 'loading') notes.Cobros = 'Buscando…';
  if (cobros.state === 'error') notes.Cobros = 'No se pudo buscar';
  if (cobros.state === 'ok') {
    for (const row of cobros.items.slice(0, PALETTE_LIMIT)) {
      const label = filaCobro(row, tz);
      if (label && row.ref) {
        const ref = row.ref;
        options.push({ group: 'Cobros', key: `c-${row.kind}-${row.id}`, label, run: () => { onClose(); onOpenRef(ref); } });
      }
    }
  }
  if (q.trim() && sees('operators')) {
    if (people === 'error') notes.Personas = 'No se pudo buscar';
    else if (people) {
      for (const p of personasDe(people.chicas, people.camareros, q)) {
        options.push({ group: 'Personas', key: `o-${p.id}`, label: p.nombre, detail: p.tipo, run: () => { onClose(); fichas?.openOperator(p.id); } });
      }
    }
  }
  if (cards.state === 'loading') notes.Fichas = 'Buscando…';
  if (cards.state === 'error') notes.Fichas = 'No se pudo buscar';
  if (cards.state === 'ok') {
    for (const card of cards.items.slice(0, PALETTE_LIMIT)) {
      options.push({ group: 'Fichas', key: `f-${card.id}`, label: filaFicha(card), run: () => void openCard(card) });
    }
  }
  if (opening === 'busy') notes.Fichas = 'Abriendo…';
  if (opening === 'error') notes.Fichas = 'No se pudo abrir el saldo';

  const current = Math.min(active, Math.max(0, options.length - 1));
  const searching = cobros.state === 'loading' || cards.state === 'loading' || (q.trim() !== '' && sees('operators') && people === null);
  const nothing = q.trim() !== '' && options.length === 0 && !searching && Object.keys(notes).length === 0;

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (options.length === 0) return;
      setActive((current + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      options[current]?.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  const groups: Group[] = ['Pantallas', 'Acciones', 'Cobros', 'Personas', 'Fichas'];
  const optionId = (i: number) => `np-cmdk-opt-${i}`;

  return (
    <Sheet open={open} onClose={onClose} title="Buscar" wide="dialog" width="35rem" full>
      <input
        ref={inputRef}
        className="np-cmdk-input"
        type="search"
        role="combobox"
        aria-label="Buscar"
        aria-expanded={options.length > 0}
        aria-controls={LIST_ID}
        aria-autocomplete="list"
        aria-activedescendant={options.length > 0 ? optionId(current) : undefined}
        placeholder="Busca un cobro, una persona, una ficha o una pantalla"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        maxLength={128}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpening(null);
        }}
        onKeyDown={onKeyDown}
      />
      <ul id={LIST_ID} className="np-cmdk-results" role="listbox" aria-label="Resultados">
        {groups.map((group) => {
          const rows = options.map((o, i) => ({ o, i })).filter((x) => x.o.group === group);
          if (rows.length === 0 && !notes[group]) return null;
          return (
            <li key={group} role="presentation">
              <p className="np-cmdk-group" aria-hidden="true">
                {group}
              </p>
              <ul role="group" aria-label={group} className="np-cmdk-results">
                {rows.map(({ o, i }) => (
                  <li
                    key={o.key}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === current}
                    className="np-cmdk-option"
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={o.run}
                  >
                    <span>{o.label}</span>
                    {o.detail ? <span>{o.detail}</span> : null}
                  </li>
                ))}
              </ul>
              {notes[group] ? (
                <p className="np-cmdk-note" role="status">
                  {notes[group]}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {nothing ? (
        <p className="np-cmdk-note" role="status">
          Nada con «{q.trim()}»
        </p>
      ) : null}
    </Sheet>
  );
}
