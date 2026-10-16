'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Card } from '@nightpay/ui';
import { MyNightCard } from './MyNightCard';
import {
  fetchMyEarnings,
  fetchMyPayouts,
  type MyEarning,
  type MyPayout,
} from '@/lib/api';
import { formatBps, formatEur, formatSignedEur } from '@/lib/money';

type Mode = 'earnings' | 'payouts';

export function Earnings() {
  const [mode, setMode] = useState<Mode>('earnings');
  const [earnings, setEarnings] = useState<MyEarning[]>([]);
  const [payouts, setPayouts] = useState<MyPayout[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchMyEarnings(), fetchMyPayouts()])
      .then(([e, p]) => {
        if (cancelled) return;
        setEarnings(e);
        setPayouts(p);
      })
      .catch((err) => !cancelled && setError((err as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <MyNightCard />
      <div style={tabSwitchStyle}>
        <SwitchBtn active={mode === 'earnings'} onClick={() => setMode('earnings')}>
          Comisiones
        </SwitchBtn>
        <SwitchBtn active={mode === 'payouts'} onClick={() => setMode('payouts')}>
          Liquidaciones
        </SwitchBtn>
      </div>
      {error ? (
        <Card role="alert" style={{ padding: '0.875rem', borderColor: 'var(--np-danger)' }}>
          <p style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.85rem' }}>{error}</p>
        </Card>
      ) : null}
      {loading ? (
        <p style={emptyText}>Cargando…</p>
      ) : mode === 'earnings' ? (
        earnings.length === 0 ? (
          <p style={emptyText}>Aún no tienes comisiones registradas.</p>
        ) : (
          earnings.map((e) => (
            <Card key={e.id} style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={timeStyle}>{formatTime(e.createdAt)}</span>
                <span
                  className="np-num"
                  style={{
                    fontWeight: 600,
                    color: netColor(e),
                  }}
                >
                  {formatSignedEur(e.netCents)}
                </span>
              </div>
              <p style={smallMeta}>
                Cobro {formatEur(e.paymentAmountCents)} · {formatBps(e.commissionBps)}
                {e.reversedCents > 0 ? ` · devolución −${formatEur(e.reversedCents)}` : ''}
                {e.payoutId ? ' · liquidada' : ' · pendiente'}
              </p>
            </Card>
          ))
        )
      ) : payouts.length === 0 ? (
        <p style={emptyText}>Sin liquidaciones aún.</p>
      ) : (
        payouts.map((p) => (
          <Card key={p.id} style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={timeStyle}>{formatTime(p.createdAt)}</span>
              <span className="np-num" style={{ fontWeight: 600 }}>
                {formatEur(p.totalCents)}
              </span>
            </div>
            <p style={smallMeta}>
              {p.earningCount} cobro{p.earningCount === 1 ? '' : 's'} · pagado por {p.paidByEmail ?? '—'}
              {p.notes ? ` · ${p.notes}` : ''}
            </p>
          </Card>
        ))
      )}
    </div>
  );
}

/** En rojo si se le descuenta; en ámbar si una devolución se comió parte. */
function netColor(e: MyEarning): string {
  if (e.netCents < 0) return 'var(--np-danger)';
  return e.netCents < e.commissionCents ? 'var(--np-warning)' : 'var(--np-success)';
}

function SwitchBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        background: active ? 'var(--np-surface-2)' : 'transparent',
        border: '1px solid var(--np-border)',
        borderRadius: 'var(--np-r-pill)',
        padding: '0.5rem 1rem',
        color: active ? 'var(--np-accent)' : 'var(--np-text-mute)',
        fontWeight: 500,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
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

const tabSwitchStyle: CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
};

const cardStyle: CSSProperties = {
  padding: '1rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
};

const timeStyle: CSSProperties = {
  fontSize: 'var(--np-t-label)',
  color: 'var(--np-text-mute)',
};

const smallMeta: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-label)',
  color: 'var(--np-text-mute)',
};

const emptyText: CSSProperties = {
  textAlign: 'center',
  color: 'var(--np-text-dim)',
  padding: '3rem 1rem',
  margin: 0,
};
