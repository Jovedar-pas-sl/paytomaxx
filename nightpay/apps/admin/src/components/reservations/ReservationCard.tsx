'use client';

import { useState, type CSSProperties } from 'react';
import { Button } from '@nightpay/ui';
import { formatMoney, type ReservationView } from '@nightpay/contracts';
import { markNoShow, setTable, venueCancel, venueChangeDate } from '@/lib/endpoints/reservations';
import { nightLabel, reservationActions, statusTone } from '@/lib/reservations';

type Ask = 'date' | 'cancel' | null;

/**
 * Una reserva en la lista de la noche: quién, qué paquete, lo pagado y lo que
 * falta, «vendido por», la mesa (la pone el local), y las acciones del
 * encargado: cambiar la fecha (el local la ofrece), «Cancelar» si no está
 * pagada o «Devolver» si lo está (el dinero está en el saldo del grupo:
 * se devuelve en Clientes → Saldos), y «No vino» cuando su noche ha acabado.
 */
export function ReservationCard({
  r,
  overdue,
  onChanged,
}: {
  r: ReservationView;
  overdue?: boolean;
  onChanged: (next: ReservationView | null, notice?: string) => void;
}) {
  const actions = reservationActions(r);
  const [table, setTableText] = useState(r.tableLabel ?? '');
  const [ask, setAsk] = useState<Ask>(null);
  const [date, setDate] = useState(r.nightDate);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(task: () => Promise<{ view: ReservationView; notice?: string }>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const out = await task();
      setAsk(null);
      onChanged(out.view, out.notice);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const tone = statusTone(r.status);
  return (
    <article style={card} aria-labelledby={`resv-${r.id}`}>
      <header style={head}>
        <h3 id={`resv-${r.id}`} style={title}>
          {r.customerName} <span style={mute}>· {r.ref}</span>
        </h3>
        <span style={{ ...pill, color: TONE[tone].ink, background: TONE[tone].bg }}>{r.statusText}</span>
      </header>
      <p style={line}>
        {r.packageName} · {r.entries} {r.entries === 1 ? 'persona' : 'personas'} · {nightLabel(r.nightDate)}
        {r.previousNightDate ? <span style={mute}> (antes {nightLabel(r.previousNightDate)})</span> : null}
      </p>
      <p style={line}>
        Pagado <b>{formatMoney(r.paidCents)}</b> de {formatMoney(r.priceCents)}
        {r.pendingCents > 0 && r.status !== 'CANCELED' ? <span> · falta {formatMoney(r.pendingCents)}</span> : null}
        {r.balanceCents !== null && r.status === 'ARRIVED' && r.kind === 'CREDIT' ? <span> · queda {formatMoney(r.balanceCents)}</span> : null}
      </p>
      <p style={{ ...line, ...mute }}>
        {r.soldBy}
        {r.customerPhone ? ` · ${r.customerPhone}` : ''}
        {r.notes ? ` · «${r.notes}»` : ''}
      </p>
      {r.status === 'ARRIVED' && r.kind === 'ITEMS' ? (
        <p style={line}>Queda: {r.itemsLeft.map((i) => `${i.left} de ${i.qty} ${i.name}`).join(' · ')}</p>
      ) : null}
      {actions.table ? (
        <div style={row}>
          <label style={label} htmlFor={`table-${r.id}`}>
            Mesa
          </label>
          <input id={`table-${r.id}`} style={input} value={table} maxLength={20} onChange={(e) => setTableText(e.target.value)} />
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || table === (r.tableLabel ?? '')}
            onClick={() => void run(async () => ({ view: await setTable(r.id, table.trim() || null) }))}
          >
            Guardar mesa
          </Button>
        </div>
      ) : null}
      <div style={row}>
        {actions.changeDate ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setAsk(ask === 'date' ? null : 'date')}>
            Cambiar fecha
          </Button>
        ) : null}
        {actions.cancel ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setAsk(ask === 'cancel' ? null : 'cancel')}>
            {actions.cancel}
          </Button>
        ) : null}
        {overdue ? (
          <Button variant="danger" size="sm" loading={busy} onClick={() => void run(async () => ({ view: await markNoShow(r.id), notice: `${r.ref}: no vino. La señal no se devuelve.` }))}>
            No vino
          </Button>
        ) : null}
      </div>
      {ask === 'date' ? (
        <div style={confirm} role="group" aria-label="Cambiar la fecha">
          <p style={line}>El local ofrece otra noche (no gasta el cambio que tiene el cliente).</p>
          <div style={row}>
            <input type="date" style={input} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Nueva noche" />
            <Button size="sm" loading={busy} disabled={date === r.nightDate} onClick={() => void run(async () => ({ view: await venueChangeDate(r.id, date) }))}>
              Cambiar a esa noche
            </Button>
          </div>
        </div>
      ) : null}
      {ask === 'cancel' ? (
        <div style={{ ...confirm, borderColor: 'var(--np-danger)' }} role="group" aria-label={actions.cancel ?? ''}>
          <p style={line}>
            {actions.cancel === 'Devolver'
              ? `El local anula el reservado y devuelve ${formatMoney(r.paidCents)}: el dinero queda en su saldo y se devuelve desde Clientes → Saldos («Devolver saldo»).`
              : 'Se anula la reserva sin pagar.'}
          </p>
          <input style={input} placeholder="Motivo" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} aria-label="Motivo" />
          <Button
            variant="danger"
            size="sm"
            loading={busy}
            disabled={reason.trim().length < 2}
            onClick={() =>
              void run(async () => {
                const out = await venueCancel(r.id, reason.trim());
                return {
                  view: out.reservation,
                  notice: out.refundCents > 0 ? `Devuelve ${formatMoney(out.refundCents)} en Clientes → Saldos (saldo «Reservado ${r.ref}»).` : undefined,
                };
              })
            }
          >
            Sí, {actions.cancel === 'Devolver' ? 'anular y devolver' : 'cancelar'}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="np-set-error" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
    </article>
  );
}

const TONE = {
  ok: { ink: 'var(--np-success)', bg: 'var(--np-pill-success-bg)' },
  warn: { ink: 'var(--np-warning)', bg: 'var(--np-pill-warning-bg)' },
  bad: { ink: 'var(--np-danger-text)', bg: 'var(--np-pill-danger-bg)' },
  mute: { ink: 'var(--np-text-mute)', bg: 'var(--np-pill-mute-bg)' },
} as const;

const card: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.875rem 1rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  background: 'var(--np-surface)',
};
const head: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' };
const title: CSSProperties = { margin: 0, fontSize: '1rem', fontWeight: 700 };
const mute: CSSProperties = { color: 'var(--np-text-mute)', fontWeight: 400 };
const line: CSSProperties = { margin: 0, fontSize: '0.875rem' };
const pill: CSSProperties = { padding: '0.125rem 0.625rem', borderRadius: 'var(--np-r-pill)', fontSize: '0.875rem', fontWeight: 600 };
const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' };
const label: CSSProperties = { fontSize: '0.875rem', fontWeight: 600 };
const input: CSSProperties = {
  minHeight: '2.5rem',
  padding: '0 0.625rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  background: 'var(--np-surface-2, transparent)',
  color: 'inherit',
  font: 'inherit',
  fontSize: '0.875rem',
};
const confirm: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.75rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
};
