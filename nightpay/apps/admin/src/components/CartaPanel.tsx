'use client';

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input, Select } from '@nightpay/ui';
import { MAX_PACK_COMPONENTS, parseEuroCents, type SectionCode } from '@nightpay/contracts';
import { createServiceItem, fetchCarta, updateServiceItem, type ServiceItem, type ServiceItemInput } from '@/lib/api';
import { groupBySection, packFromDraft, packRemainder, type PartDraft } from '@/lib/carta-form';
import { centsToInput, formatEur } from '@/lib/money';
import { enabledSections, sectionLabelOf } from '@/lib/money-map';
import { useSections } from '@/lib/use-sections';
import { SectionDot } from './fichas/SectionChip';
import { Notice } from './Notice';

/**
 * Carta del local (Fase 1A; el mapa del dinero). Lo que el personal toca
 * para cobrar, de todas las secciones (copas, habitaciones, comida,
 * entradas, servicios): el precio y la sección salen de aquí, nadie los
 * teclea. Un pack se reparte solo entre secciones («1 h con habitación» =
 * Servicios + Habitaciones): la comisión de la chica, solo sobre su parte.
 */
export function CartaPanel() {
  const { sections } = useSections();
  const [items, setItems] = useState<ServiceItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoadError(null);
    fetchCarta()
      .then(setItems)
      .catch((err: Error) => setLoadError(err.message));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function toggleActive(item: ServiceItem) {
    setError(null);
    try {
      await updateServiceItem(item.id, { active: !item.active });
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div>
        <h2 style={titleStyle}>Carta</h2>
        <p style={hintStyle}>
          Lo que el personal toca en su app para cobrar, sección por sección. El precio y la sección salen de aquí: nadie
          los teclea a mano. Los nombres y colores de las secciones, en Ajustes → Secciones.
        </p>
      </div>

      <Card style={{ padding: '1.25rem' }}>
        <h3 style={subtitleStyle}>Añadir a la carta</h3>
        <ServiceForm
          submitLabel="Añadir a la carta"
          onSubmit={async (input) => {
            await createServiceItem(input);
            reload();
          }}
        />
      </Card>

      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: 0 }}>
          {error}
        </p>
      ) : null}

      {loadError ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: reload }}>
          No se pudo cargar la carta: {loadError}
        </Notice>
      ) : null}

      {items === null ? (
        loadError ? null : <p style={hintStyle}>Cargando carta…</p>
      ) : items.length === 0 ? (
        <Card style={{ padding: '1.25rem' }}>
          <p style={{ margin: 0 }}>Todavía no hay nada. Añade el primero arriba: por ejemplo «Copa» a 10 € en Copas.</p>
        </Card>
      ) : (
        groupBySection(items, sections).map((group) => (
          <div key={group.code} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <h3 style={groupTitle}>
              {group.color ? <SectionDot color={group.color} /> : null}
              {group.label}
              {group.enabled ? null : <span style={{ color: 'var(--np-text-dim)', fontWeight: 500 }}> · apagada</span>}
            </h3>
            {group.items.map((item) =>
              editing === item.id ? (
                <Card key={item.id} style={{ padding: '1.25rem' }}>
                  <ServiceForm
                    initial={item}
                    submitLabel="Guardar cambios"
                    onCancel={() => setEditing(null)}
                    onSubmit={async (input) => {
                      await updateServiceItem(item.id, input);
                      setEditing(null);
                      reload();
                    }}
                  />
                </Card>
              ) : (
                <Card
                  key={item.id}
                  style={{
                    padding: '1rem 1.25rem',
                    opacity: item.active ? 1 : 0.55,
                    borderLeft: `0.375rem solid ${group.color ?? 'var(--np-border-hi)'}`,
                  }}
                >
                  <div style={rowStyle}>
                    <div style={{ minWidth: 0, flex: '1 1 12rem' }}>
                      <p style={{ margin: 0, fontWeight: 700, fontSize: '1.0625rem' }}>
                        {item.name}
                        {item.durationMin ? (
                          <span style={{ color: 'var(--np-text-mute)', fontWeight: 500 }}> · {item.durationMin} min</span>
                        ) : null}
                      </p>
                      <p style={{ ...hintStyle, marginTop: '0.125rem' }}>
                        {item.components && item.components.length > 0
                          ? `Pack: ${item.components.map((c) => `${sectionLabelOf(sections, c.category)} ${formatEur(c.amountCents)}`).join(' + ')}`
                          : sectionLabelOf(sections, item.category)}
                        {item.active ? '' : ' · desactivado'}
                      </p>
                    </div>
                    <span className="np-num" style={priceStyle}>
                      {formatEur(item.priceCents)}
                    </span>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <Button variant="ghost" style={smallBtn} onClick={() => setEditing(item.id)}>
                        Editar
                      </Button>
                      <Button variant="ghost" style={smallBtn} onClick={() => void toggleActive(item)}>
                        {item.active ? 'Desactivar' : 'Activar'}
                      </Button>
                    </div>
                  </div>
                </Card>
              ),
            )}
          </div>
        ))
      )}
    </section>
  );
}

function ServiceForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: ServiceItem;
  submitLabel: string;
  onSubmit: (input: ServiceItemInput) => Promise<void>;
  onCancel?: () => void;
}) {
  const { sections } = useSections();
  const choices = enabledSections(sections);
  const firstCode = choices[0]?.code ?? 'CHICA_SERVICE';
  const initialCategory: SectionCode =
    initial && initial.category !== 'EXTRA' ? initial.category : (firstCode as SectionCode);
  const [name, setName] = useState(initial?.name ?? '');
  const [duration, setDuration] = useState(initial?.durationMin ? String(initial.durationMin) : '');
  const [price, setPrice] = useState(initial ? centsToInput(initial.priceCents) : '');
  const [category, setCategory] = useState<SectionCode>(initialCategory);
  const [isPack, setIsPack] = useState(Boolean(initial?.components && initial.components.length > 0));
  const [parts, setParts] = useState<PartDraft[]>(
    initial?.components?.map((c) => ({ category: c.category, amount: centsToInput(c.amountCents) })) ?? [
      { category: initialCategory, amount: '' },
      { category: (choices.find((s) => s.code !== initialCategory)?.code ?? 'VENUE_ROOM') as SectionCode, amount: '' },
    ],
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const priceCents = parseEuroCents(price) ?? 0;
  const remainder = isPack ? packRemainder(priceCents, parts) : 0;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const durationMin = duration.trim() ? parseInt(duration, 10) : null;
    if (!name.trim()) return setError('Pon un nombre, por ejemplo «30 min» o «Copa».');
    if (priceCents <= 0) return setError('Pon un precio mayor que 0.');
    if (durationMin !== null && (!Number.isFinite(durationMin) || durationMin <= 0)) {
      return setError('La duración son minutos: un número mayor que 0, o déjalo vacío.');
    }
    let components: ServiceItemInput['components'] = initial?.components ? null : undefined;
    if (isPack) {
      const pack = packFromDraft(priceCents, category, parts);
      if (!pack.ok) return setError(pack.problem);
      components = pack.components;
    }
    setSubmitting(true);
    try {
      await onSubmit({ name: name.trim(), durationMin, priceCents, category, ...(components !== undefined ? { components } : {}) });
      if (!initial) {
        setName('');
        setDuration('');
        setPrice('');
        setIsPack(false);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
      <div style={formGrid}>
        <Input label="Nombre" value={name} onChange={(e) => setName(e.target.value)} placeholder="Copa" maxLength={60} />
        <Input label="Precio (€)" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="10" />
        <Input
          label="Duración (min, opcional)"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          inputMode="numeric"
          placeholder="30"
        />
        <Select label="Sección" value={category} onChange={(e) => setCategory(e.target.value as SectionCode)}>
          {choices.map((s) => (
            <option key={s.code} value={s.code}>
              {s.label}
            </option>
          ))}
        </Select>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600 }}>
        <input type="checkbox" checked={isPack} onChange={(e) => setIsPack(e.target.checked)} style={{ width: '1.25rem', height: '1.25rem' }} />
        Es un pack (se reparte entre secciones)
      </label>

      {isPack ? (
        <fieldset style={packBox}>
          <legend style={{ fontWeight: 700, padding: '0 0.25rem' }}>Partes del pack</legend>
          {parts.map((part, i) => (
            <div key={i} style={partRow}>
              <Select
                aria-label={`Sección de la parte ${i + 1}`}
                value={part.category}
                onChange={(e) => setParts(parts.map((p, j) => (j === i ? { ...p, category: e.target.value as SectionCode } : p)))}
              >
                {choices.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.label}
                  </option>
                ))}
              </Select>
              <Input
                aria-label={`Importe de la parte ${i + 1} (€)`}
                value={part.amount}
                inputMode="decimal"
                placeholder="€"
                onChange={(e) => setParts(parts.map((p, j) => (j === i ? { ...p, amount: e.target.value } : p)))}
              />
              {parts.length > 2 ? (
                <Button type="button" variant="ghost" style={smallBtn} onClick={() => setParts(parts.filter((_, j) => j !== i))}>
                  Quitar
                </Button>
              ) : null}
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            {parts.length < MAX_PACK_COMPONENTS ? (
              <Button
                type="button"
                variant="ghost"
                style={smallBtn}
                onClick={() => setParts([...parts, { category: firstCode as SectionCode, amount: '' }])}
              >
                Añadir parte
              </Button>
            ) : null}
            <span role="status" style={{ ...hintStyle, marginTop: 0, color: remainder === 0 ? 'var(--np-success)' : 'var(--np-warning)' }}>
              {remainder === 0
                ? 'Las partes suman el precio.'
                : remainder > 0
                  ? `Faltan ${formatEur(remainder)} para el precio.`
                  : `Sobran ${formatEur(-remainder)} sobre el precio.`}
            </span>
          </div>
        </fieldset>
      ) : null}

      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: 0 }}>
          {error}
        </p>
      ) : null}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <Button type="submit" loading={submitting}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
        ) : null}
      </div>
    </form>
  );
}

const titleStyle: CSSProperties = { margin: 0, fontSize: 'var(--np-t-h3)', fontWeight: 700 };
const subtitleStyle: CSSProperties = { margin: '0 0 0.875rem', fontSize: '1rem', fontWeight: 700 };
const groupTitle: CSSProperties = { margin: '0.5rem 0 0', fontSize: '1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' };
const hintStyle: CSSProperties = { margin: '0.25rem 0 0', color: 'var(--np-text-mute)', fontSize: '0.9375rem' };
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' };
const priceStyle: CSSProperties = { fontSize: '1.25rem', fontWeight: 700, marginLeft: 'auto' };
const smallBtn: CSSProperties = { height: '2.5rem', padding: '0 1rem', fontSize: '0.875rem' };
const formGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))',
  gap: '0.75rem',
};
const packBox: CSSProperties = {
  margin: 0,
  padding: '0.75rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  minWidth: 0,
};
const partRow: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))',
  gap: '0.5rem',
  alignItems: 'center',
};
