'use client';

import { useState, type CSSProperties } from 'react';
import { Button, Card, StatusPill, type PaymentStatus } from '@nightpay/ui';
import { cancelPayment, fetchMyPayments, pollErrorText, SessionExpiredError, type MyPayment } from '@/lib/api';
import { paymentTimeLabel } from '@/lib/earnings-view';
import { formatEur } from '@/lib/money';
import { usePolling } from '@/lib/use-polling';

const POLL_MS = 5000;

export function MyPayments() {
  // null: aún no ha llegado la primera carga.
  const [items, setItems] = useState<MyPayment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = usePolling(
    async (signal) => {
      try {
        setItems(await fetchMyPayments(signal));
        setError(null);
      } catch (err) {
        if (signal.aborted) return 'slow';
        setError(pollErrorText(err));
        return err instanceof SessionExpiredError ? 'stop' : 'slow';
      }
    },
    { intervalMs: POLL_MS },
  );

  async function onCancel(id: string) {
    setBusyId(id);
    try {
      await cancelPayment(id);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  // El error va primero: con la lista vacía no se escondía detrás de "Aún no has creado cobros".
  const errorCard = error ? (
    <Card role="alert" style={{ padding: '0.875rem', borderColor: 'var(--np-danger)' }}>
      <p style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.85rem' }}>{error}</p>
    </Card>
  ) : null;

  if (items === null) {
    return errorCard ?? <p style={emptyText}>Cargando…</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {errorCard}
      {items.length === 0 ? <p style={emptyText}>Aún no has creado cobros.</p> : null}
      {items.map((p) => {
        const cancelable =
          p.status === 'CREATED' || p.status === 'AWAITING_CAPTURE';
        return (
          <Card key={p.id} style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span className="np-num" style={amountStyle}>
                {formatEur(p.amountCents)}
              </span>
              <span style={timeStyle}>{paymentTimeLabel(p.createdAt)}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <StatusPill status={p.status as PaymentStatus} size="sm" />
              {cancelable ? (
                <Button
                  variant="ghost"
                  size="md"
                  onClick={() => onCancel(p.id)}
                  loading={busyId === p.id}
                  style={{ marginLeft: 'auto', height: '2.25rem', padding: '0 1rem', fontSize: '0.8125rem' }}
                >
                  Cancelar
                </Button>
              ) : null}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

const amountStyle: CSSProperties = {
  fontSize: '1.25rem',
  fontWeight: 600,
  letterSpacing: '-0.02em',
};

const timeStyle: CSSProperties = {
  fontSize: 'var(--np-t-label)',
  color: 'var(--np-text-mute)',
};

const emptyText: CSSProperties = {
  textAlign: 'center',
  color: 'var(--np-text-dim)',
  padding: '3rem 1rem',
  margin: 0,
};
