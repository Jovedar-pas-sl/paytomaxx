'use client';

import { useEffect, useRef, useState, type ComponentProps, type FormEvent } from 'react';
import { Button, Checkbox, Icon, Importe, Input, Select, Sheet } from '@nightpay/ui';
import { CHARGE_METHOD_LABELS, LEGACY_SECTION_META, type ChargeMethod, type CobroRow } from '@nightpay/contracts';
import { fetchCobros, fetchOperators, type CobrosFilters, type Operator } from '@/lib/api';
import { cobrosCsv, collectCobros, csvFileName } from '@/lib/cobros-csv';
import { nextSearch, SEARCH_MIN_CHARS } from '@/lib/cobros-search';
import { cobrosTotals, totalsLead, totalsParts } from '@/lib/cobros-totals';
import {
  COBROS_COLUMNS,
  COBROS_VIEWS,
  STATUS_OPTIONS,
  activeFilterCount,
  activeView,
  applyView,
  filterChips,
  withoutFilters,
  type CobrosColumn,
} from '@/lib/cobros-views';
import { isPartyEdition } from '@/lib/edition';
import { FILTER_FIELD } from '@/lib/filter-field';
import { enabledSections } from '@/lib/money-map';
import { saveBlob } from '@/lib/save-file';
import { useSections } from '@/lib/use-sections';
import { useVenueTimezone } from '@/lib/venue-context';
import { SelectorNoches } from './SelectorNoches';

/** Lo que se pide de una vez al descargar (el tope de `limit` del API). */
const DOWNLOAD_PAGE = 200;

// OxioParty no cobra con bitcoin.
const METHODS: ChargeMethod[] = isPartyEdition() ? ['CARD', 'MOBILE_WALLET', 'POS', 'SALDO'] : ['CARD', 'MOBILE_WALLET', 'POS', 'SALDO', 'BITCOIN'];

type Download = { state: 'idle' } | { state: 'loading'; count: number } | { state: 'done'; note: string | null } | { state: 'error' };

interface Props {
  value: CobrosFilters;
  onChange: (next: CobrosFilters) => void;
  /** Los cobros cargados (null: cargando): sobre ellos se calcula el total. */
  rows: CobroRow[] | null;
  /** Quedan páginas por cargar: el total dice «Los 50 últimos». */
  hasMore: boolean;
  columns: readonly CobrosColumn[];
  onColumns: (next: CobrosColumn[]) => void;
  /** «Descargar»: el dueño, y el encargado con «ver informes». */
  canExport: boolean;
  /** El selector de fechas (por noches); null en OxioParty (todas las fechas, como siempre). */
  periodo: ComponentProps<typeof SelectorNoches> | null;
  /** Lo que se pide al API (la lista con sus fechas): lo mismo se descarga. null: aún no se puede pedir. */
  fetchFilter: CobrosFilters | null;
}

/**
 * La barra de Cobros: las vistas (atajos de estado y forma de pago), el
 * selector de fechas (SelectorNoches), el buscador, «Estado» y «Más filtros» en una línea, «Columnas» y
 * «Descargar» a la derecha; debajo, una ficha por filtro puesto y el total de
 * lo cargado. En el móvil, el buscador y «Filtros (N)» con todo dentro. Los
 * filtros van al API tal cual (los mismos de siempre).
 */
export function CobrosToolbar({ value, onChange, rows, hasMore, columns, onColumns, canExport, periodo, fetchFilter }: Props) {
  const tz = useVenueTimezone();
  const { sections } = useSections();
  const party = isPartyEdition();
  const [operators, setOperators] = useState<Operator[]>([]);
  const [search, setSearch] = useState(value.search ?? '');
  const [code, setCode] = useState(value.walletCode ?? '');
  const [open, setOpen] = useState<'status' | 'more' | 'all' | 'columns' | null>(null);
  const [download, setDownload] = useState<Download>({ state: 'idle' });
  const statusRef = useRef<HTMLSpanElement>(null);
  const columnsRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    // Las compañeras son de OxioPay: en OxioParty no hay ese filtro.
    if (!party) {
      fetchOperators()
        .then(setOperators)
        .catch(() => undefined);
    }
  }, [party]);

  // Lo que se quita con una ficha o llega de fuera (el mapa, un enlace) se ve también en los campos.
  useEffect(() => setSearch(value.search ?? ''), [value.search]);
  useEffect(() => setCode(value.walletCode ?? ''), [value.walletCode]);
  // Otro filtro: lo que dijo la descarga anterior ya no vale.
  useEffect(() => setDownload((d) => (d.state === 'loading' ? d : { state: 'idle' })), [value]);

  const set = (patch: Partial<CobrosFilters>) => onChange(withoutFilters({ ...value, ...patch }, []));
  const close = () => setOpen(null);

  function applySearch(e?: FormEvent): void {
    e?.preventDefault();
    const next = nextSearch(search, value.search);
    if ((value.search ?? '') !== next) set({ search: next || undefined });
  }

  function applyCode(): void {
    const clean = code.trim();
    if ((value.walletCode ?? '') !== clean) set({ walletCode: clean || undefined });
  }

  function toggleStatus(status: string, on: boolean): void {
    const current = value.status ?? [];
    set({ status: on ? [...current.filter((s) => s !== status), status] : current.filter((s) => s !== status) });
  }

  async function runDownload(): Promise<void> {
    const filter = fetchFilter;
    if (!filter) return;
    setDownload({ state: 'loading', count: 0 });
    try {
      const { rows: all, capped } = await collectCobros(
        (cursor) => fetchCobros(filter, { cursor, limit: DOWNLOAD_PAGE }),
        (count) => setDownload({ state: 'loading', count }),
      );
      if (all.length === 0) {
        setDownload({ state: 'done', note: 'No hay cobros con estos filtros' });
        return;
      }
      saveBlob(new Blob([cobrosCsv(all, { tz, sections })], { type: 'text/csv;charset=utf-8' }), csvFileName(new Date(), tz));
      setDownload({ state: 'done', note: capped ? 'Solo van los 5.000 más recientes. Acota las fechas o el estado.' : null });
    } catch {
      setDownload({ state: 'error' });
    }
  }

  const view = activeView(value);
  // Con el selector, «Fechas del mapa» va en su botón (con «Quitar»): sin ficha repetida.
  const chips = filterChips(value, { tz, nights: [], operators: operators.map((o) => ({ id: o.id, name: o.displayName ?? o.email })), sections }).filter(
    (chip) => !(periodo && chip.key === 'fechas'),
  );
  const count = activeFilterCount(value);
  const totals = rows ? cobrosTotals(rows) : null;

  const downloadButton = () =>
    canExport ? (
      <Button variant="ghost" size="sm" disabled={download.state === 'loading' || !fetchFilter} onClick={() => void runDownload()}>
        {download.state === 'loading' ? `Descargando… ${download.count > 0 ? download.count.toLocaleString('es-ES') : ''}` : 'Descargar'}
      </Button>
    ) : null;

  // Lo que dijo la última descarga (si no cupo todo, si no había nada o si falló).
  const downloadNote =
    download.state === 'error' ? (
      <p className="np-cobros-download" role="alert">
        No se pudo descargar.
        <Button variant="ghost" size="sm" onClick={() => void runDownload()}>
          Reintentar
        </Button>
      </p>
    ) : download.state === 'done' && download.note ? (
      <p className="np-cobros-download" role="status">
        {download.note}
      </p>
    ) : null;

  const statusBoxes = STATUS_OPTIONS.map((s) => (
    <Checkbox key={s.value} label={s.label} checked={(value.status ?? []).includes(s.value)} onChange={(on) => toggleStatus(s.value, on)} />
  ));

  return (
    <div className="np-cobros-toolbar" data-tour="cobros-filtros">
      {periodo ? <SelectorNoches {...periodo} /> : null}
      <div className="np-cobros-views" role="group" aria-label="Vistas">
        {COBROS_VIEWS.map((v) => (
          <button key={v.key} type="button" className="np-cobros-view" aria-pressed={view === v.key} onClick={() => onChange(applyView(value, v.key))}>
            {v.label}
          </button>
        ))}
      </div>

      <div className="np-cobros-bar">
        <form className="np-cobros-search" onSubmit={applySearch} role="search">
          <Input
            type="search"
            aria-label="Buscar un cobro"
            placeholder="C-0022, código, ficha o 4 últimos"
            title="La referencia (C-0022), el código de 3 letras, la referencia del banco, los 4 últimos de la tarjeta (tarjeta 4242) o el número de la ficha (ficha 522). Pulsa Intro para buscar."
            enterKeyHint="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onBlur={() => applySearch()}
            minLength={SEARCH_MIN_CHARS}
            maxLength={128}
            style={FILTER_FIELD}
          />
        </form>
        <span className="np-cobros-anchor" ref={statusRef} data-wide-only="">
          <Button variant="ghost" size="sm" aria-haspopup="true" aria-expanded={open === 'status'} onClick={() => setOpen('status')}>
            Estado <span aria-hidden="true">▾</span>
          </Button>
        </span>
        <Button variant="ghost" size="sm" data-wide-only="" onClick={() => setOpen('more')}>
          Más filtros
        </Button>
        <Button variant="ghost" size="sm" data-mobile-only="" onClick={() => setOpen('all')}>
          {count > 0 ? `Filtros (${count})` : 'Filtros'}
        </Button>
        <span className="np-cobros-bar-end" data-wide-only="">
          <span className="np-cobros-anchor" ref={columnsRef}>
            <Button variant="ghost" size="sm" aria-haspopup="true" aria-expanded={open === 'columns'} onClick={() => setOpen('columns')}>
              Columnas
            </Button>
          </span>
          {downloadButton()}
        </span>
      </div>

      {chips.length > 0 ? (
        <div className="np-cobros-chips">
          {chips.map((chip) => (
            <button key={chip.key} type="button" className="np-cobros-chip" aria-label={`${chip.label}. Quitar`} onClick={() => onChange(withoutFilters(value, chip.clears))}>
              {chip.label}
              <Icon name="close" size={20} />
            </button>
          ))}
          <button type="button" className="np-cobros-clear" onClick={() => onChange({})}>
            Quitar todo
          </button>
        </div>
      ) : null}

      {open === 'all' ? null : downloadNote}

      {totals && totals.count > 0 ? (
        <p className="np-cobros-total">
          {totalsLead(totals.count, hasMore)}
          {totalsParts(totals).map((p) => (
            <span key={p.label}>
              {' · '}
              <Importe cents={p.cents} decimals="always" /> {p.label}
            </span>
          ))}
        </p>
      ) : null}

      <Sheet open={open === 'status'} onClose={close} title="Estado" wide="menu" anchorRef={statusRef}>
        <div className="np-cobros-menu">{statusBoxes}</div>
      </Sheet>

      <Sheet open={open === 'columns'} onClose={close} title="Columnas" wide="menu" anchorRef={columnsRef}>
        <div className="np-cobros-menu">
          {COBROS_COLUMNS.map((c) => (
            <Checkbox
              key={c.key}
              label={c.label}
              checked={columns.includes(c.key)}
              onChange={(on) => onColumns(COBROS_COLUMNS.map((x) => x.key).filter((k) => (k === c.key ? on : columns.includes(k))))}
            />
          ))}
        </div>
      </Sheet>

      {/* «Más filtros» (pantalla ancha) y «Filtros» (móvil, con el estado y la descarga dentro). */}
      <Sheet
        open={open === 'more' || open === 'all'}
        onClose={close}
        title={open === 'all' ? 'Filtros' : 'Más filtros'}
        footer={
          <Button
            onClick={() => {
              applyCode();
              close();
            }}
          >
            Ver cobros
          </Button>
        }
      >
        <form
          className="np-cobros-sheet"
          onSubmit={(e) => {
            e.preventDefault();
            applyCode();
          }}
        >
          {open === 'all' ? (
            <>
              <fieldset>
                <legend>Estado</legend>
                {statusBoxes}
              </fieldset>
            </>
          ) : null}
          {party ? null : (
            <Select label="Compañera" value={value.operatorId ?? ''} onChange={(e) => set({ operatorId: e.target.value || undefined })}>
              <option value="">Todas</option>
              {operators.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.displayName ?? o.email}
                </option>
              ))}
            </Select>
          )}
          <Select label="Sección" value={value.category ?? ''} onChange={(e) => set({ category: e.target.value || undefined })}>
            <option value="">Todas</option>
            {enabledSections(sections).map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
            <option value="EXTRA">{LEGACY_SECTION_META.label} (antiguos)</option>
          </Select>
          <Select label="Forma de pago" value={value.method ?? ''} onChange={(e) => set({ method: (e.target.value || undefined) as ChargeMethod | undefined })}>
            <option value="">Cualquiera</option>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {CHARGE_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
          <Input
            label="Código del saldo"
            placeholder="K7Q-4M2"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onBlur={applyCode}
            maxLength={12}
            autoCapitalize="characters"
          />
          {open === 'all' ? (
            <>
              {downloadButton()}
              {downloadNote}
            </>
          ) : null}
        </form>
      </Sheet>
    </div>
  );
}
