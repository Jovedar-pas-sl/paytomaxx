'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input } from '@nightpay/ui';
import type { PendingTopUpView } from '@nightpay/contracts';
import { assignPendingTopUp, fetchPendingTopUps } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { formatEur } from '@/lib/money';
import { assignedText, normalizeSaldoCode, saldoCodeProblem } from '@/lib/pending-topups';
import { useVenueTimezone } from '@/lib/venue-context';

/**
 * Recargas cobradas sin el NFC del cliente (Inicio → «Recargar saldo», plan
 * B): el dinero espera en su recarga hasta sumarse al saldo del cliente. Aquí
 * se asignan con su código (con su NFC, en Recepción). Sin ninguna, no sale.
 */
export function PendingTopUps() {
  const tz = useVenueTimezone();
  const [rows, setRows] = useState<PendingTopUpView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  if (rows !== null && rows.length === 0 && !notice && !error) return null;

  return (
    <Card style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div style={headerStyle}>
        <h3 style={titleStyle}>Recargas pendientes de asignar</h3>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          Actualizar
        </Button>
      </div>
      <p style={mutedStyle}>
        Cobradas sin el NFC del cliente. Teclea el código de su saldo y se suman a él. El dinero no se pierde: espera aquí.
      </p>
      {notice ? (
        <p role="status" style={{ margin: 0, color: 'var(--np-success)', fontWeight: 600 }}>
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" style={{ margin: 0, color: 'var(--np-danger)' }}>
          {error}
        </p>
      ) : null}
      {rows === null ? <p style={mutedStyle}>Cargando…</p> : null}
      <ul style={listStyle}>
        {(rows ?? []).map((r) => (
          <AssignRow
            key={r.walletId}
            row={r}
            when={formatDateTime(r.since, tz)}
            onAssigned={(text) => {
              setNotice(text);
              void load();
            }}
          />
        ))}
      </ul>
    </Card>
  );
}

function AssignRow({ row, when, onAssigned }: { row: PendingTopUpView; when: string; onAssigned: (text: string) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const problem = saldoCodeProblem(code);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      onAssigned(assignedText(await assignPendingTopUp(row.walletId, normalizeSaldoCode(code))));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li style={rowStyle}>
      <span className="np-num" style={{ fontWeight: 700 }}>
        {formatEur(row.amountCents)}
      </span>
      <span style={mutedStyle}>
        {when}
        {row.byName ? ` · ${row.byName}` : ''}
      </span>
      <form onSubmit={(e) => void submit(e)} style={formStyle}>
        <div style={{ width: '8.5rem' }}>
          <Input
            aria-label="Código del saldo del cliente"
            placeholder="K7Q-4M2"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            autoComplete="off"
          />
        </div>
        <Button type="submit" size="sm" loading={busy}>
          Asignar
        </Button>
      </form>
      {error ? (
        <p role="alert" style={{ margin: 0, width: '100%', color: 'var(--np-danger)', fontSize: '0.875rem' }}>
          {error}
        </p>
      ) : null}
    </li>
  );
}

const headerStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' };
const titleStyle: CSSProperties = { margin: 0, fontSize: '1rem', fontWeight: 700 };
const mutedStyle: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '0.875rem' };
const listStyle: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' };
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  flexWrap: 'wrap',
  padding: '0.5rem 0',
  borderBottom: '1px solid var(--np-border)',
};
const formStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: 'auto' };
