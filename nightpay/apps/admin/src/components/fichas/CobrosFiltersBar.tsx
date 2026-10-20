'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Input, Select } from '@nightpay/ui';
import { CHARGE_METHOD_LABELS, LEGACY_SECTION_META, type ChargeMethod } from '@nightpay/contracts';
import { fetchNights, fetchOperators, type CobrosFilters, type NightListItem, type Operator } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { enabledSections } from '@/lib/money-map';
import { useSections } from '@/lib/use-sections';
import { useVenueTimezone } from '@/lib/venue-context';

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Todos los estados' },
  { value: 'CREATED', label: 'Creado' },
  { value: 'AUTHORIZING', label: 'Esperando pago' },
  { value: 'AUTHORIZED', label: 'Pagado' },
  { value: 'FAILED', label: 'Rechazado' },
  { value: 'EXPIRED', label: 'Caducado' },
  { value: 'REFUNDED', label: 'Devuelto' },
  { value: 'PARTIALLY_REFUNDED', label: 'Devuelto en parte' },
  { value: 'ORPHAN', label: 'Sin confirmar' },
];

const METHODS: ChargeMethod[] = ['CARD', 'MOBILE_WALLET', 'POS', 'SALDO'];

/** Filtros de Cobros: estado, chica, sección, cómo pagó, saldo y noche (van al API). */
export function CobrosFiltersBar({ value, onChange }: { value: CobrosFilters; onChange: (next: CobrosFilters) => void }) {
  const tz = useVenueTimezone();
  const { sections } = useSections();
  const [operators, setOperators] = useState<Operator[]>([]);
  const [nights, setNights] = useState<NightListItem[]>([]);
  const [code, setCode] = useState(value.walletCode ?? '');

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
    if ((value.walletCode ?? '') !== clean) set({ walletCode: clean || undefined });
  }

  return (
    <form className="np-cobros-filters" style={grid} onSubmit={applyCode} role="search" aria-label="Filtrar cobros">
      <Select aria-label="Estado" value={value.status?.[0] ?? ''} onChange={(e) => set({ status: e.target.value ? [e.target.value] : undefined })}>
        {STATUS_FILTERS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </Select>
      <Select aria-label="Chica" value={value.operatorId ?? ''} onChange={(e) => set({ operatorId: e.target.value || undefined })}>
        <option value="">Todas las chicas</option>
        {operators.map((o) => (
          <option key={o.id} value={o.id}>
            {o.displayName ?? o.email}
          </option>
        ))}
      </Select>
      <Select aria-label="Sección" value={value.category ?? ''} onChange={(e) => set({ category: e.target.value || undefined })}>
        <option value="">Todas las secciones</option>
        {enabledSections(sections).map((s) => (
          <option key={s.code} value={s.code}>
            {s.label}
          </option>
        ))}
        <option value="EXTRA">{LEGACY_SECTION_META.label} (antiguos)</option>
      </Select>
      <Select
        aria-label="Cómo pagó"
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
      <Select aria-label="Noche" value={value.nightId ?? ''} onChange={(e) => set({ nightId: e.target.value || undefined })}>
        <option value="">Todas las noches</option>
        {nights.map((n) => (
          <option key={n.id} value={n.id}>
            {formatDateTime(n.openedAt, tz, 'short')}
            {n.closedAt ? '' : ' (abierta)'}
          </option>
        ))}
      </Select>
      <Input
        aria-label="Código del saldo"
        placeholder="Saldo K7Q-4M2"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onBlur={() => applyCode()}
        maxLength={12}
        autoCapitalize="characters"
      />
    </form>
  );
}

const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(10.5rem, 1fr))',
  gap: '0.5rem',
};
