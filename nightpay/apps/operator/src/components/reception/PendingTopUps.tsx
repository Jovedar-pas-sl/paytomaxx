'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import type { PendingTopUpView } from '@nightpay/contracts';
import { Button, Card } from '@nightpay/ui';
import { fetchPendingTopUps } from '@/lib/api-noche';
import { formatEur } from '@/lib/money';
import { StaffOutcome } from '../StaffOutcome';
import { AssignTopUp } from './AssignTopUp';

/**
 * Recepción → Pendientes de asignar: recargas cobradas sin el NFC del cliente
 * (Inicio → «Recargar saldo», plan B). Se toca una y se acerca su NFC o se
 * teclea su código: se suma a su saldo.
 */
export function PendingTopUps({ onDone }: { onDone: () => void }) {
  const [rows, setRows] = useState<PendingTopUpView[] | null>(null);
  const [picked, setPicked] = useState<PendingTopUpView | null>(null);
  const [assigned, setAssigned] = useState<{ amountCents: number; detail: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      setRows(await fetchPendingTopUps());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (assigned) {
    return (
      <StaffOutcome
        kind="paid"
        amountCents={assigned.amountCents}
        message="Recarga asignada"
        detail={<p>{assigned.detail}</p>}
        primary={{
          label: 'Ver las pendientes',
          onClick: () => {
            setAssigned(null);
            void load();
          },
        }}
        secondary={{ label: 'Volver', onClick: onDone }}
      />
    );
  }

  if (picked) {
    return (
      <AssignTopUp
        walletId={picked.walletId}
        amountCents={picked.amountCents}
        onAssigned={(out) => {
          setPicked(null);
          setAssigned({ amountCents: out.amountCents, detail: `Saldo ${out.codeHint} · tiene ${formatEur(out.balanceCents)}` });
        }}
        onLater={() => setPicked(null)}
      />
    );
  }

  return (
    <Card style={cardStyle}>
      <p style={kicker}>Pendientes de asignar</p>
      <p style={muted}>Recargas cobradas sin el NFC del cliente. Toca una y acerca su NFC (o teclea su código).</p>
      {rows === null && !error ? <p style={muted}>Cargando…</p> : null}
      {rows?.length === 0 ? <p style={big}>No hay ninguna pendiente.</p> : null}
      {(rows ?? []).map((r) => (
        <Button key={r.walletId} size="lg" variant="ghost" onClick={() => setPicked(r)} style={rowBtn}>
          <span className="np-num" style={{ fontWeight: 700 }}>
            {formatEur(r.amountCents)}
          </span>
          <span style={muted}>
            {new Date(r.since).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' })}
            {r.byName ? ` · ${r.byName}` : ''}
          </span>
        </Button>
      ))}
      {error ? (
        <p role="alert" style={{ margin: 0, color: 'var(--np-danger)', fontWeight: 600 }}>
          {error}
        </p>
      ) : null}
      <Button variant="ghost" onClick={() => void load()}>
        Actualizar
      </Button>
      <Button variant="ghost" onClick={onDone}>
        Volver
      </Button>
    </Card>
  );
}

const cardStyle: CSSProperties = { padding: 'var(--np-pad-card)', display: 'flex', flexDirection: 'column', gap: 'var(--np-gap)', textAlign: 'center' };
const kicker: CSSProperties = {
  margin: 0,
  fontSize: '0.8125rem',
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--np-text-mute)',
};
const big: CSSProperties = { margin: 0, fontSize: '1.25rem', fontWeight: 700 };
const muted: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '0.95rem' };
const rowBtn: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: '0.75rem' };
