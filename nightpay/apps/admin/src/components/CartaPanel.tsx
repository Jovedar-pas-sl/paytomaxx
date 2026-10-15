'use client';

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input, Select } from '@nightpay/ui';
import { parseEuroCents } from '@nightpay/contracts';
import {
  createServiceItem,
  fetchCarta,
  updateServiceItem,
  type RevenueCategory,
  type ServiceItem,
  type ServiceItemInput,
} from '@/lib/api';
import { centsToInput, formatEur } from '@/lib/money';
import { Notice } from './Notice';

const CATEGORY_LABEL: Record<RevenueCategory, string> = {
  CHICA_SERVICE: 'Servicio de la chica',
  VENUE_BAR: 'Barra / bebida',
  VENUE_ROOM: 'Habitación',
  VENUE_FOOD: 'Comida',
  EXTRA: 'Otro',
};

/**
 * Carta de servicios del local (Fase 1A). Lo que se pone aquí es lo que la
 * chica (y el camarero) tocan para cobrar: el precio y la categoría salen de
 * la carta, no los teclea quien cobra.
 */
export function CartaPanel() {
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
        <h2 style={titleStyle}>Carta de servicios</h2>
        <p style={hintStyle}>
          Lo que las chicas tocan en su app para cobrar. El precio sale de aquí: nadie lo teclea a mano.
          Las chicas solo ven los servicios de chica; barra, habitación y comida los cobra el camarero.
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
          <p style={{ margin: 0 }}>
            Todavía no hay servicios. Añade el primero arriba: por ejemplo «30 min» a 100 €.
          </p>
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {items.map((item) =>
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
                style={{ padding: '1rem 1.25rem', opacity: item.active ? 1 : 0.55 }}
              >
                <div style={rowStyle}>
                  <div style={{ minWidth: 0, flex: '1 1 12rem' }}>
                    <p style={{ margin: 0, fontWeight: 700, fontSize: '1.0625rem' }}>
                      {item.name}
                      {item.durationMin ? (
                        <span style={{ color: 'var(--np-text-mute)', fontWeight: 500 }}>
                          {' '}· {item.durationMin} min
                        </span>
                      ) : null}
                    </p>
                    <p style={{ ...hintStyle, marginTop: '0.125rem' }}>
                      {CATEGORY_LABEL[item.category]}
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
  const [name, setName] = useState(initial?.name ?? '');
  const [duration, setDuration] = useState(initial?.durationMin ? String(initial.durationMin) : '');
  const [price, setPrice] = useState(initial ? centsToInput(initial.priceCents) : '');
  const [category, setCategory] = useState<RevenueCategory>(initial?.category ?? 'CHICA_SERVICE');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const priceCents = parseEuroCents(price) ?? Number.NaN;
    const durationMin = duration.trim() ? parseInt(duration, 10) : null;
    if (!name.trim()) return setError('Pon un nombre, por ejemplo «30 min».');
    if (!Number.isFinite(priceCents) || priceCents <= 0) return setError('Pon un precio mayor que 0.');
    if (durationMin !== null && (!Number.isFinite(durationMin) || durationMin <= 0)) {
      return setError('La duración son minutos: un número mayor que 0, o déjalo vacío.');
    }
    setSubmitting(true);
    try {
      await onSubmit({ name: name.trim(), durationMin, priceCents, category });
      if (!initial) {
        setName('');
        setDuration('');
        setPrice('');
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
        <Input label="Nombre" value={name} onChange={(e) => setName(e.target.value)} placeholder="30 min" maxLength={60} />
        <Input
          label="Precio (€)"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          inputMode="decimal"
          placeholder="100"
        />
        <Input
          label="Duración (min, opcional)"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          inputMode="numeric"
          placeholder="30"
        />
        <Select label="Tipo" value={category} onChange={(e) => setCategory(e.target.value as RevenueCategory)}>
          {(Object.keys(CATEGORY_LABEL) as RevenueCategory[]).map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </Select>
      </div>
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
const hintStyle: CSSProperties = { margin: '0.25rem 0 0', color: 'var(--np-text-mute)', fontSize: '0.9375rem' };
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' };
const priceStyle: CSSProperties = { fontSize: '1.25rem', fontWeight: 700, marginLeft: 'auto' };
const smallBtn: CSSProperties = { height: '2.5rem', padding: '0 1rem', fontSize: '0.875rem' };
const formGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))',
  gap: '0.75rem',
};
