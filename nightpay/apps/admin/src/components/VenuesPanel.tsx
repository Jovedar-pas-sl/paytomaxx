'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input, Modal } from '@nightpay/ui';
import {
  createVenue,
  fetchAllVenues,
  switchTenant,
  type VenueListItem,
} from '@/lib/api';

interface Props {
  currentSlug: string;
}

/**
 * Tab "Locales" — solo visible para super admin.
 *
 * Funcionalidad:
 *   - Lista todos los locales con su nombre, slug, timezone, fecha de creación
 *   - Indicador del local ACTIVO (donde estás operando ahora)
 *   - Botón "Cambiar a este local" para switchear contexto
 *   - Botón "Crear nuevo local" → modal con name + slug + timezone
 *
 * NO permite eliminar locales (soft-delete ya soportado en schema pero la UI
 * no lo expone por seguridad — un mistap borraría el universo de un local).
 * Si necesitas borrar uno, hazlo via SQL o futura confirmación con typed-slug.
 */
export function VenuesPanel({ currentSlug }: Props) {
  const [venues, setVenues] = useState<VenueListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  async function reload() {
    try {
      const v = await fetchAllVenues();
      setVenues(v);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function handleSwitch(tenantId: string) {
    try {
      const res = await switchTenant(tenantId);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('np_admin_token', res.accessToken);
        const raw = window.localStorage.getItem('np_admin_user');
        if (raw) {
          const u = JSON.parse(raw) as { tenantId: string; venueSlug: string };
          u.tenantId = res.tenantId;
          u.venueSlug = res.venueSlug;
          window.localStorage.setItem('np_admin_user', JSON.stringify(u));
        }
      }
      window.location.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (loading) return <p style={loadingStyle}>Cargando locales…</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <Card style={{ padding: '1rem 1.25rem' }}>
        <div style={headerRow}>
          <div>
            <h2 style={titleStyle}>Locales</h2>
            <p style={subtitleStyle}>
              {venues.length} local{venues.length === 1 ? '' : 'es'} bajo tu cuenta · activo:{' '}
              <code style={code}>{currentSlug}</code>
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>+ Nuevo local</Button>
        </div>
      </Card>

      {error ? (
        <Card style={{ padding: '1rem', borderColor: 'var(--np-danger)' }}>
          <p style={{ color: 'var(--np-danger)', margin: 0 }}>{error}</p>
        </Card>
      ) : null}

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Nombre</th>
              <th style={thStyle}>Slug</th>
              <th style={thStyle}>Zona horaria</th>
              <th style={thStyle}>Creado</th>
              <th style={thStyle}>Acción</th>
            </tr>
          </thead>
          <tbody>
            {venues.map((v) => {
              const isActive = v.slug === currentSlug;
              return (
                <tr key={v.id} style={isActive ? rowActiveStyle : rowStyle}>
                  <td style={tdStyle}>
                    {v.name} {isActive ? <span style={badgeStyle}>activo</span> : null}
                  </td>
                  <td style={tdMonoStyle}>{v.slug}</td>
                  <td style={tdStyle}>{v.timezone}</td>
                  <td style={tdMonoStyle}>
                    {new Date(v.createdAt).toLocaleDateString('es-ES')}
                  </td>
                  <td style={tdStyle}>
                    {isActive ? (
                      <span style={{ color: 'var(--np-text-dim)', fontSize: '0.8rem' }}>—</span>
                    ) : (
                      <Button variant="ghost" onClick={() => handleSwitch(v.id)}>
                        Cambiar a éste
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <CreateVenueModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void reload();
        }}
      />
    </div>
  );
}

function CreateVenueModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [timezone, setTimezone] = useState('Europe/Madrid');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function autoSlug(rawName: string): string {
    return rawName
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const finalSlug = slug.trim() || autoSlug(name);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(finalSlug)) {
      setError('Slug debe ser kebab-case (letras/números separados por guion)');
      return;
    }
    setSubmitting(true);
    try {
      await createVenue({ name: name.trim(), slug: finalSlug, timezone });
      setName('');
      setSlug('');
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Nuevo local" width="28rem">
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <Input
          label="Nombre"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slug.trim()) setSlug('');
          }}
          placeholder='ej. "Luna Valencia"'
          required
          autoFocus
        />
        <Input
          label="Slug (URL-safe, único)"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder={name ? autoSlug(name) : 'ej. luna-vlc'}
          hint="kebab-case. Si lo dejas vacío se genera del nombre."
        />
        <Input
          label="Zona horaria"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          hint="ej. Europe/Madrid, America/Mexico_City"
        />
        {error ? (
          <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
            {error}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button type="submit" loading={submitting}>
            Crear local
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-h3)',
  fontWeight: 600,
  letterSpacing: '-0.02em',
};

const subtitleStyle: CSSProperties = {
  margin: '0.25rem 0 0',
  fontSize: '0.8125rem',
  color: 'var(--np-text-mute)',
};

const code: CSSProperties = {
  fontFamily: 'var(--np-font-mono)',
  background: 'var(--np-surface)',
  padding: '0.1rem 0.4rem',
  borderRadius: '4px',
  fontSize: '0.78rem',
};

const headerRow: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: '1rem',
  flexWrap: 'wrap',
};

const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '0.875rem',
};

const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '0.75rem 1rem',
  background: 'var(--np-surface-2)',
  borderBottom: '1px solid var(--np-border)',
  fontSize: '0.7rem',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--np-text-dim)',
  fontWeight: 600,
};

const rowStyle: CSSProperties = {
  borderBottom: '1px solid var(--np-border)',
};

const rowActiveStyle: CSSProperties = {
  ...rowStyle,
  background: 'var(--np-surface-2)',
};

const tdStyle: CSSProperties = {
  padding: '0.75rem 1rem',
  verticalAlign: 'middle',
};

const tdMonoStyle: CSSProperties = {
  ...tdStyle,
  fontFamily: 'var(--np-font-mono)',
  fontSize: '0.8rem',
  color: 'var(--np-text-mute)',
};

const badgeStyle: CSSProperties = {
  display: 'inline-block',
  marginLeft: '0.5rem',
  padding: '0.1rem 0.4rem',
  fontSize: '0.65rem',
  fontWeight: 600,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  background: 'var(--np-accent)',
  color: 'var(--np-on-accent, #fff)',
  borderRadius: '0.25rem',
};

const loadingStyle: CSSProperties = {
  textAlign: 'center',
  color: 'var(--np-text-dim)',
  padding: '3rem 1rem',
  margin: 0,
};
