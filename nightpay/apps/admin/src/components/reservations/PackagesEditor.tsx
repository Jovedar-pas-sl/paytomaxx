'use client';

import { useState, type CSSProperties } from 'react';
import { Button } from '@nightpay/ui';
import { formatMoney, reservationDepositCents, type ReservationPackageView } from '@nightpay/contracts';
import { createPackage, setPackageActive, updatePackage } from '@/lib/endpoints/reservations';
import { emptyPackageForm, eurosToCents, packageFormToInput, packageSummary, packageToForm, type PackageForm } from '@/lib/reservations';

/**
 * Paquetes (dueño o encargado): de cosas fijas (entradas, botellas…) o de un
 * importe para consumir. Las personas = las entradas = un QR por persona. La
 * señal es el 30 % del precio. Cambiar un paquete no cambia las reservas ya
 * hechas; apagarlo lo quita de la web y de los enlaces de los RRPP.
 */
export function PackagesEditor({ packages, onChanged }: { packages: ReservationPackageView[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(p: ReservationPackageView): Promise<void> {
    setBusy(p.id);
    setError(null);
    try {
      await setPackageActive(p.id, !p.active);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={stack}>
      {packages.length === 0 ? <p className="np-set-note">Aún no hay paquetes. Crea el primero.</p> : null}
      {packages.map((p) =>
        editing === p.id ? (
          <PackageFormBox key={p.id} initial={packageToForm(p)} id={p.id} onDone={() => (setEditing(null), onChanged())} onCancel={() => setEditing(null)} />
        ) : (
          <article key={p.id} style={{ ...card, opacity: p.active ? 1 : 0.7 }}>
            <div style={head}>
              <h3 style={title}>
                {p.name} · {formatMoney(p.priceCents)}
              </h3>
              <span style={mute}>{p.active ? 'A la venta' : 'Apagado'}</span>
            </div>
            <p style={line}>{packageSummary(p)}</p>
            <p style={line}>
              Señal {formatMoney(p.depositCents)} (30 %){p.maxPerNight ? ` · como mucho ${p.maxPerNight} por noche` : ''}
            </p>
            <div style={row}>
              <Button variant="ghost" size="sm" onClick={() => setEditing(p.id)}>
                Cambiar
              </Button>
              <Button variant="ghost" size="sm" loading={busy === p.id} onClick={() => void toggle(p)}>
                {p.active ? 'Apagar' : 'Encender'}
              </Button>
            </div>
          </article>
        ),
      )}
      {editing === 'new' ? (
        <PackageFormBox initial={emptyPackageForm()} id={null} onDone={() => (setEditing(null), onChanged())} onCancel={() => setEditing(null)} />
      ) : (
        <Button onClick={() => setEditing('new')}>Nuevo paquete</Button>
      )}
      {error ? (
        <p role="alert" className="np-set-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function PackageFormBox({ initial, id, onDone, onCancel }: { initial: PackageForm; id: string | null; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState<PackageForm>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof PackageForm) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const price = eurosToCents(f.price);

  async function save(): Promise<void> {
    const out = packageFormToInput(f);
    if (!out.ok) return setError(out.error);
    setBusy(true);
    setError(null);
    try {
      await (id ? updatePackage(id, out.input) : createPackage(out.input));
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ ...card, gap: '0.625rem' }} aria-label={id ? 'Cambiar paquete' : 'Nuevo paquete'}>
      <Field label="Nombre">
        <input style={input} value={f.name} maxLength={60} onChange={set('name')} />
      </Field>
      <div style={row} role="radiogroup" aria-label="Tipo de paquete">
        {(['ITEMS', 'CREDIT'] as const).map((k) => (
          <label key={k} style={radio}>
            <input type="radio" name={`kind-${id ?? 'new'}`} checked={f.kind === k} onChange={() => setF({ ...f, kind: k })} />
            {k === 'ITEMS' ? 'Cosas fijas (entradas, botellas…)' : 'Importe para consumir'}
          </label>
        ))}
      </div>
      <div style={row}>
        <Field label="Precio (€)">
          <input style={input} inputMode="decimal" value={f.price} onChange={set('price')} />
        </Field>
        <Field label="Personas">
          <input style={input} inputMode="numeric" value={f.entries} onChange={set('entries')} />
        </Field>
        <Field label="Máximo por noche (opcional)">
          <input style={input} inputMode="numeric" value={f.maxPerNight} onChange={set('maxPerNight')} />
        </Field>
      </div>
      {price !== null ? <p style={line}>Señal: {formatMoney(reservationDepositCents(price))} (30 %, no se devuelve)</p> : null}
      {f.kind === 'CREDIT' ? (
        <Field label="Importe para consumir (€)">
          <input style={input} inputMode="decimal" value={f.credit} onChange={set('credit')} />
        </Field>
      ) : (
        <Field label="Qué incluye (una cosa por línea, p. ej. «2 Botella premium»)">
          <textarea style={{ ...input, minHeight: '5rem', paddingTop: '0.5rem' }} value={f.items} onChange={set('items')} />
        </Field>
      )}
      <Field label="Descripción (opcional)">
        <input style={input} value={f.description} maxLength={200} onChange={set('description')} />
      </Field>
      <div style={row}>
        <Button loading={busy} onClick={() => void save()}>
          Guardar
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          No guardar
        </Button>
      </div>
      {error ? (
        <p role="alert" className="np-set-error" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={field}>
      <span style={{ fontSize: '0.875rem', fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  );
}

const stack: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.75rem' };
const card: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  padding: '0.875rem 1rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  background: 'var(--np-surface)',
};
const head: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' };
const title: CSSProperties = { margin: 0, fontSize: '1rem', fontWeight: 700 };
const mute: CSSProperties = { color: 'var(--np-text-mute)', fontSize: '0.875rem' };
const line: CSSProperties = { margin: 0, fontSize: '0.875rem' };
const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'flex-end' };
const radio: CSSProperties = { display: 'flex', gap: '0.375rem', alignItems: 'center', fontSize: '0.875rem' };
const field: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: '1 1 10rem' };
const input: CSSProperties = {
  minWidth: 0,
  minHeight: '2.75rem',
  padding: '0 0.75rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  background: 'var(--np-surface-2, transparent)',
  color: 'inherit',
  font: 'inherit',
  fontSize: '1rem',
};
