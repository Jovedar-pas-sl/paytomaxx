'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Button } from '@nightpay/ui';
import { formatMoney, type ReservationPackageView, type ReservationView } from '@nightpay/contracts';
import { bookFromPanel, fetchNight, fetchOverdue } from '@/lib/endpoints/reservations';
import { addDays, currentNight, nightLabel } from '@/lib/reservations';
import { ReservationCard } from './ReservationCard';

/**
 * «Reservas»: las de una noche (por defecto, la de ahora), las de noches
 * pasadas que siguen sin llegada (para marcar «No vino») y reservar para un
 * cliente desde el panel (vendido por: el panel), con el enlace para que pague.
 */
export function NightList({ packages }: { packages: ReservationPackageView[] }) {
  const [night, setNight] = useState(currentNight());
  const [list, setList] = useState<ReservationView[] | null>(null);
  const [overdue, setOverdue] = useState<ReservationView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rows, late] = await Promise.all([fetchNight(night), fetchOverdue()]);
      setList(rows);
      setOverdue(late);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [night]);

  useEffect(() => {
    void load();
  }, [load]);

  function changed(_next: ReservationView | null, text?: string): void {
    setNotice(text ?? null);
    void load();
  }

  const live = list?.filter((r) => r.status !== 'CANCELED') ?? [];
  const people = live.reduce((a, r) => a + r.entries, 0);
  return (
    <div style={stack}>
      <div style={row} role="group" aria-label="Noche" data-tour="reservados-noche">
        <Button variant="ghost" size="sm" onClick={() => setNight(addDays(night, -1))} aria-label="Noche anterior">
          ‹
        </Button>
        <input type="date" style={input} value={night} onChange={(e) => e.target.value && setNight(e.target.value)} aria-label="Noche" />
        <Button variant="ghost" size="sm" onClick={() => setNight(addDays(night, 1))} aria-label="Noche siguiente">
          ›
        </Button>
        {night !== currentNight() ? (
          <Button variant="ghost" size="sm" onClick={() => setNight(currentNight())}>
            Esta noche
          </Button>
        ) : null}
      </div>
      <p className="np-set-note" style={{ margin: 0 }}>
        {nightLabel(night)}: {live.length} {live.length === 1 ? 'reservado' : 'reservados'} · {people} personas
      </p>
      {notice ? (
        <p role="status" style={noticeStyle}>
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="np-set-error">
          {error}
        </p>
      ) : null}
      {list === null && !error ? <p className="np-set-note">Cargando…</p> : null}
      {list?.length === 0 ? <p className="np-set-note">No hay reservados esta noche.</p> : null}
      {list?.map((r) => <ReservationCard key={r.id} r={r} onChanged={changed} />)}
      {overdue.length > 0 ? (
        <section style={stack} aria-label="Sin llegada de noches pasadas">
          <h3 style={h3}>Sin llegada de noches pasadas</h3>
          <p className="np-set-note" style={{ margin: 0 }}>
            Si no vinieron: «No vino». La señal no se devuelve; si pagaron todo, el resto les queda de saldo para otra noche.
          </p>
          {overdue.map((r) => (
            <ReservationCard key={r.id} r={r} overdue onChanged={changed} />
          ))}
        </section>
      ) : null}
      <BookForm packages={packages} night={night} onBooked={() => void load()} />
    </div>
  );
}

/** Reservar para un cliente desde el panel: el enlace se le manda para que pague. */
function BookForm({ packages, night, onBooked }: { packages: ReservationPackageView[]; night: string; onBooked: () => void }) {
  const active = packages.filter((p) => p.active);
  const [open, setOpen] = useState(false);
  const [packageId, setPackageId] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  if (active.length === 0) return null;
  if (!open) {
    return (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Reservar para un cliente
      </Button>
    );
  }
  const chosen = packageId || active[0]!.id;

  async function book(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const key = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      const out = await bookFromPanel({ packageId: chosen, nightDate: night, customerName: name.trim(), customerPhone: phone.trim(), key });
      setLink(out.link);
      onBooked();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ ...stack, ...box }} aria-label="Reservar para un cliente">
      <h3 style={h3}>Reservar para un cliente · {nightLabel(night)}</h3>
      <select style={input} value={chosen} onChange={(e) => setPackageId(e.target.value)} aria-label="Paquete">
        {active.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {formatMoney(p.priceCents)} (señal {formatMoney(p.depositCents)})
          </option>
        ))}
      </select>
      <input style={input} placeholder="Nombre" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-label="Nombre" />
      <input style={input} placeholder="Teléfono" inputMode="tel" value={phone} maxLength={32} onChange={(e) => setPhone(e.target.value)} aria-label="Teléfono" />
      <Button loading={busy} disabled={name.trim().length < 2 || phone.trim().length < 6} onClick={() => void book()}>
        Reservar
      </Button>
      {link ? (
        <p className="np-set-note" style={{ margin: 0 }}>
          Mándale este enlace para que pague la señal o todo: <a href={link}>{link}</a>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="np-set-error" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

const stack: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.75rem' };
const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' };
const h3: CSSProperties = { margin: 0, fontSize: '1rem', fontWeight: 700 };
const box: CSSProperties = { padding: '0.875rem 1rem', border: '1px solid var(--np-border)', borderRadius: 'var(--np-r-md)' };
const noticeStyle: CSSProperties = { margin: 0, padding: '0.625rem 0.875rem', borderLeft: '4px solid var(--np-warning)', fontSize: '0.875rem' };
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
