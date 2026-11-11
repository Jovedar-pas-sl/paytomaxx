'use client';

import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Button, Input, Select } from '@nightpay/ui';
import { CHARGE_METHOD_LABELS, LEGACY_SECTION_META, type ChargeMethod } from '@nightpay/contracts';
import { fetchNights, fetchOperators, type CobrosFilters, type NightListItem, type Operator } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { FILTER_FIELD, FILTER_SELECT } from '@/lib/filter-field';
import { enabledSections } from '@/lib/money-map';
import { useSections } from '@/lib/use-sections';
import { useVenueTimezone } from '@/lib/venue-context';
import { nextSearch, SEARCH_MIN_CHARS } from '@/lib/cobros-search';

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Todos los estados' },
  // La misma palabra que la tabla (cobro-status): «Sin pagar».
  { value: 'CREATED', label: 'Sin pagar' },
  { value: 'AUTHORIZING', label: 'Esperando pago' },
  { value: 'AUTHORIZED', label: 'Pagado' },
  { value: 'FAILED', label: 'Rechazado' },
  { value: 'EXPIRED', label: 'Caducado' },
  { value: 'REFUNDED', label: 'Devuelto' },
  { value: 'PARTIALLY_REFUNDED', label: 'Devuelto en parte' },
  { value: 'ORPHAN', label: 'Sin confirmar' },
];

const METHODS: ChargeMethod[] = ['CARD', 'MOBILE_WALLET', 'POS', 'SALDO'];

/** Filtros de Cobros: estado, chica, sección, cómo pagó, saldo, noche y las fechas de una cifra del mapa (van al API). */
export function CobrosFiltersBar({ value, onChange }: { value: CobrosFilters; onChange: (next: CobrosFilters) => void }) {
  const tz = useVenueTimezone();
  const { sections } = useSections();
  const [operators, setOperators] = useState<Operator[]>([]);
  const [nights, setNights] = useState<NightListItem[]>([]);
  const [code, setCode] = useState(value.walletCode ?? '');
  const [search, setSearch] = useState(value.search ?? '');

  useEffect(() => {
    fetchOperators()
      .then(setOperators)
      .catch(() => undefined);
    fetchNights()
      .then((list) => setNights(list.slice(0, 30)))
      .catch(() => undefined);
  }, []);

  const set = (patch: Partial<CobrosFilters>) => {
    const next = { ...value, ...patch };
    for (const k of Object.keys(next) as Array<keyof CobrosFilters>) {
      const v = next[k];
      if (v === '' || v === undefined || (Array.isArray(v) && v.length === 0)) delete next[k];
    }
    onChange(next);
  };

  function applyCode(e?: FormEvent): void {
    e?.preventDefault();
    const clean = code.trim();
    const reference = nextSearch(search, value.search);
    if ((value.walletCode ?? '') !== clean || (value.search ?? '') !== reference) set({ walletCode: clean || undefined, search: reference || undefined });
  }

  return (
    <>
    {value.from || value.to ? (
      <p className="np-cobros-window" role="status">
        <span>
          Fechas del mapa del dinero: {value.from ? formatDateTime(value.from, tz, 'compact') : 'el principio'} →{' '}
          {value.to ? formatDateTime(value.to, tz, 'compact') : 'ahora'} (hora del cobro)
        </span>
        <button type="button" onClick={() => set({ from: undefined, to: undefined })}>
          Quitar fechas
        </button>
      </p>
    ) : null}
    <form className="np-cobros-filters" onSubmit={applyCode} role="search" aria-label="Filtrar cobros" data-tour="cobros-filtros">
      <Cell w="10.25rem">
        <Select aria-label="Estado" style={FILTER_SELECT} value={value.status?.[0] ?? ''} onChange={(e) => set({ status: e.target.value ? [e.target.value] : undefined })}>
          {STATUS_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
      </Cell>
      <Cell w="9.5rem">
        <Select aria-label="Chica" style={FILTER_SELECT} value={value.operatorId ?? ''} onChange={(e) => set({ operatorId: e.target.value || undefined })}>
          <option value="">Todas las chicas</option>
          {operators.map((o) => (
            <option key={o.id} value={o.id}>
              {o.displayName ?? o.email}
            </option>
          ))}
        </Select>
      </Cell>
      <Cell w="11rem">
        <Select aria-label="Sección" style={FILTER_SELECT} value={value.category ?? ''} onChange={(e) => set({ category: e.target.value || undefined })}>
          <option value="">Todas las secciones</option>
          {enabledSections(sections).map((s) => (
            <option key={s.code} value={s.code}>
              {s.label}
            </option>
          ))}
          <option value="EXTRA">{LEGACY_SECTION_META.label} (antiguos)</option>
        </Select>
      </Cell>
      <Cell w="13rem">
        <Select
          aria-label="Cómo pagó"
          style={FILTER_SELECT}
          value={value.method ?? ''}
          onChange={(e) => set({ method: (e.target.value || undefined) as ChargeMethod | undefined })}
        >
          <option value="">Cualquier forma de pago</option>
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {CHARGE_METHOD_LABELS[m]}
            </option>
          ))}
        </Select>
      </Cell>
      <Cell w="11.25rem">
        <Select aria-label="Noche" style={FILTER_SELECT} value={value.nightId ?? ''} onChange={(e) => set({ nightId: e.target.value || undefined })}>
          <option value="">Todas las noches</option>
          {nights.map((n) => (
            <option key={n.id} value={n.id}>
              {formatDateTime(n.openedAt, tz, 'short')}
              {n.closedAt ? '' : ' (abierta)'}
            </option>
          ))}
        </Select>
      </Cell>
      <Cell w="11.5rem">
        <Input
          aria-label="Referencia (C-0022), código, referencia del banco, 4 últimos de la tarjeta o número de ficha (al menos 3 caracteres)"
          placeholder="C-0022, código, tarjeta o ficha"
          title="La referencia (C-0022), el código de 3 letras, la referencia del banco, los 4 últimos de la tarjeta (tarjeta 4242) o el número de la ficha (ficha 522)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          minLength={SEARCH_MIN_CHARS}
          maxLength={128}
          style={FILTER_FIELD}
        />
      </Cell>
      <Cell w="8.25rem">
        <Input
          aria-label="Código del saldo"
          placeholder="Saldo K7Q-4M2"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onBlur={() => applyCode()}
          maxLength={12}
          autoCapitalize="characters"
          style={FILTER_FIELD}
        />
      </Cell>
      <Button type="submit" variant="ghost" size="sm">Buscar</Button>
    </form>
    </>
  );
}

/**
 * Un filtro de la barra: parte del ancho de su texto por defecto (medido con
 * Instrument Sans 14/500), para que ninguno salga cortado (panel-tables.css).
 */
function Cell({ w, children }: { w: string; children: ReactNode }) {
  return <div style={{ '--np-filter-w': w } as CSSProperties}>{children}</div>;
}
