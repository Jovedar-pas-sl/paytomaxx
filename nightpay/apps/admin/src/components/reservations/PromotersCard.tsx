'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Button } from '@nightpay/ui';
import { formatMoney, type PromoterView } from '@nightpay/contracts';
import { fetchOperators, type Operator } from '@/lib/endpoints/operators';
import { createPromoter, fetchPromoters, updatePromoter } from '@/lib/endpoints/reservations';
import { bpsToPercent, percentToBps } from '@/lib/reservations';

/**
 * RRPP: cada uno con su % del paquete (no hay % general) y su enlace. Venden
 * solo reservados; las entradas sueltas siguen en la puerta. La comisión se
 * gana con el paquete pagado entero y se cobra en «Pagos a compañeras», como
 * el resto del personal. El % lo pone el dueño; el encargado lo ve.
 */
export function PromotersCard({ isOwner }: { isOwner: boolean }) {
  const [list, setList] = useState<PromoterView[] | null>(null);
  const [people, setPeople] = useState<Operator[]>([]);
  const [userId, setUserId] = useState('');
  const [pct, setPct] = useState('10');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchPromoters().then(setList, (err: Error) => setError(err.message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (!isOwner) return;
    Promise.all([fetchOperators('OPERATOR'), fetchOperators('WAITER')]).then(([a, b]) => setPeople([...a, ...b]), (err: Error) => setError(err.message));
  }, [isOwner]);

  async function run(key: string, task: () => Promise<unknown>): Promise<void> {
    setBusy(key);
    setError(null);
    try {
      await task();
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const taken = new Set(list?.map((p) => p.userId) ?? []);
  const free = people.filter((p) => !taken.has(p.id));
  const newBps = percentToBps(pct);
  return (
    <div style={stack}>
      <p className="np-set-note" style={{ margin: 0 }}>
        Cada RRPP tiene su enlace y su %. Venden solo reservados. Cobran su comisión cuando el paquete está pagado entero, en «Pagos a compañeras».
      </p>
      {list?.length === 0 ? <p className="np-set-note">Aún no hay RRPP.</p> : null}
      {list?.map((p) => (
        <PromoterRow
          key={p.id}
          p={p}
          isOwner={isOwner}
          busy={busy === p.id}
          copied={copied === p.id}
          onCopy={() => void navigator.clipboard.writeText(p.url).then(() => setCopied(p.id), () => setError('Cópialo a mano'))}
          onSave={(bps) => void run(p.id, () => updatePromoter(p.id, { commissionBps: bps }))}
          onToggle={() => void run(p.id, () => updatePromoter(p.id, { active: !p.active }))}
        />
      ))}
      {isOwner ? (
        <section style={box} aria-label="Alta de RRPP">
          <h3 style={h3}>Alta de RRPP</h3>
          <p className="np-set-note" style={{ margin: 0 }}>
            Elige a una persona del equipo (compañera o camarero). Si es alguien nuevo, dalo de alta antes en el equipo.
          </p>
          <select style={input} value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Persona">
            <option value="">Elige a quién</option>
            {free.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName ?? u.email}
              </option>
            ))}
          </select>
          <label style={field}>
            <span style={label}>Su % del paquete</span>
            <input style={input} inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} />
          </label>
          <Button loading={busy === 'new'} disabled={!userId || newBps === null} onClick={() => void run('new', () => createPromoter(userId, newBps ?? 0).then(() => setUserId('')))}>
            Dar de alta
          </Button>
        </section>
      ) : null}
      {error ? (
        <p role="alert" className="np-set-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function PromoterRow(props: {
  p: PromoterView;
  isOwner: boolean;
  busy: boolean;
  copied: boolean;
  onCopy: () => void;
  onSave: (bps: number) => void;
  onToggle: () => void;
}) {
  const { p, isOwner } = props;
  const [pct, setPct] = useState(bpsToPercent(p.commissionBps));
  const bps = percentToBps(pct);
  return (
    <article style={{ ...box, opacity: p.active ? 1 : 0.7 }}>
      <div style={head}>
        <h3 style={h3}>{p.name}</h3>
        <span style={mute}>{p.active ? `${bpsToPercent(p.commissionBps)} %` : 'De baja'}</span>
      </div>
      <p style={line}>
        Pagados enteros: {p.soldCount} · su comisión: {formatMoney(p.commissionCents)}
      </p>
      {p.active ? (
        <div style={row}>
          <input readOnly style={input} value={p.url} aria-label={`Enlace de ${p.name}`} onFocus={(e) => e.currentTarget.select()} />
          <Button variant="ghost" size="sm" onClick={props.onCopy}>
            {props.copied ? 'Copiado' : 'Copiar'}
          </Button>
        </div>
      ) : null}
      {isOwner ? (
        <div style={row}>
          <input style={{ ...input, flex: '0 1 6rem' }} inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} aria-label={`% de ${p.name}`} />
          <Button variant="ghost" size="sm" loading={props.busy} disabled={bps === null || bps === p.commissionBps} onClick={() => bps !== null && props.onSave(bps)}>
            Guardar %
          </Button>
          <Button variant="ghost" size="sm" disabled={props.busy} onClick={props.onToggle}>
            {p.active ? 'Dar de baja' : 'Volver a dar de alta'}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

const stack: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.75rem' };
const box: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.875rem 1rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  background: 'var(--np-surface)',
};
const head: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' };
const h3: CSSProperties = { margin: 0, fontSize: '1rem', fontWeight: 700 };
const mute: CSSProperties = { color: 'var(--np-text-mute)', fontSize: '0.875rem' };
const line: CSSProperties = { margin: 0, fontSize: '0.875rem' };
const label: CSSProperties = { fontSize: '0.875rem', fontWeight: 600 };
const field: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.25rem' };
const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' };
const input: CSSProperties = {
  flex: '1 1 10rem',
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
