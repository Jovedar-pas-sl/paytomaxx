'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button, Card, StatusPill, type PaymentStatus } from '@nightpay/ui';
import { cancelPayment, fetchMyPayments, type MyPayment } from '@/lib/api';
import { formatEur } from '@/lib/money';

export function MyPayments() {
  const [items, setItems] = useState<MyPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function reload() {
    try {
      setItems(await fetchMyPayments());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    const int = setInterval(reload, 5000);
    return () => clearInterval(int);
  }, []);

  async function onCancel(id: string) {
    setBusyId(id);
    try {
      await cancelPayment(id);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return <p style={emptyText}>Cargando…</p>;
  }
  if (items.length === 0) {
    return <p style={emptyText}>Aún no has creado cobros.</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {error ? (
        <Card style={{ padding: '0.875rem', borderColor: 'var(--np-danger)' }}>
          <p style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.85rem' }}>{error}</p>
        </Card>
      ) : null}
      {items.map((p) => {
        const cancelable =
          p.status === 'CREATED' || p.status === 'AWAITING_CAPTURE';
        return (
          <Card key={p.id} style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span className="np-num" style={amountStyle}>
                {formatEur(p.amountCents)}
              </span>
              <span style={timeStyle}>{formatTime(p.createdAt)}</span>
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

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('es-ES', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const amountStyle: CSSProperties = {
  fontSize: '1.25rem',
  fontWeight: 600,
  letterSpacing: '-0.02em',
};

const timeStyle: CSSProperties = {
  fontSize: '0.75rem',
  color: 'var(--np-text-dim)',
};

const emptyText: CSSProperties = {
  textAlign: 'center',
  color: 'var(--np-text-dim)',
  padding: '3rem 1rem',
  margin: 0,
};
