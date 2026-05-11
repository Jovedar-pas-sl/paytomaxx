'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button, Card } from '@nightpay/ui';
import {
  fetchExchangeRate,
  fetchTreasuryStats,
  reconcilePending,
  type TreasuryStats,
} from '@/lib/api';
import { PAYOUT_METHOD_LABELS } from './PayoutMethodForm';

interface Props {
  isOwner: boolean;
}

export function TreasuryPanel({ isOwner }: Props) {
  const [stats, setStats] = useState<TreasuryStats | null>(null);
  const [rate, setRate] = useState<{ rate: number; at: string; degraded: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileMsg, setReconcileMsg] = useState<string | null>(null);

  async function reload() {
    try {
      const [s, r] = await Promise.all([fetchTreasuryStats(), fetchExchangeRate()]);
      setStats(s);
      setRate({ rate: r.rate, at: r.at, degraded: r.degraded });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    reload();
    const interval = setInterval(reload, 30_000); // refresca cada 30s
    return () => clearInterval(interval);
  }, []);

  async function handleReconcile() {
    setReconciling(true);
    setReconcileMsg(null);
    try {
      const result = await reconcilePending();
      setReconcileMsg(`Reconciliación: ${result.matched}/${result.checked} verificados.`);
      await reload();
    } catch (err) {
      setReconcileMsg(`Error: ${(err as Error).message}`);
    } finally {
      setReconciling(false);
    }
  }

  if (error) {
    return (
      <Card style={{ padding: '1rem', borderColor: 'var(--np-danger)' }}>
        <p style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>{error}</p>
      </Card>
    );
  }

  if (!stats) return <p style={loadingText}>Cargando treasury…</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Métricas grandes */}
      <section style={metricsGrid}>
        <MetricTile
          title="Saldo pendiente a chicas"
          value={(stats.pendingPayoutsCents / 100).toFixed(2)}
          unit="EUR"
          subtitle={`${stats.pendingOperatorCount} chica${stats.pendingOperatorCount === 1 ? '' : 's'}`}
          highlight
        />
        <MetricTile
          title="Pagos este mes"
          value={String(stats.payoutsThisMonthCount)}
          subtitle={`${(stats.payoutsThisMonthCents / 100).toFixed(2)} €`}
        />
        <MetricTile
          title={rate?.degraded ? '⚠️ EUR → USDT (degraded)' : 'EUR → USDT (Binance live)'}
          value={rate ? rate.rate.toFixed(4) : '—'}
          unit="USDT"
          subtitle={
            rate
              ? rate.degraded
                ? `Binance no responde — usando último-bueno o fallback`
                : `Actualizado ${formatTime(rate.at)}`
              : ''
          }
        />
        <MetricTile
          title="USDT necesarios (pendiente)"
          value={
            rate ? ((stats.pendingPayoutsCents / 100) * rate.rate).toFixed(2) : '—'
          }
          unit="USDT"
          subtitle="Para liquidar todos los pendientes"
        />
      </section>

      {/* Reconciliación */}
      {isOwner ? (
        <Card style={{ padding: '1.25rem' }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            flexWrap: 'wrap',
            gap: '1rem',
          }}>
            <div>
              <h3 style={sectionTitle}>Reconciliación on-chain</h3>
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--np-text-mute)' }}>
                Recorre payouts UNRECONCILED con hash on-chain y reintenta verificación contra Tronscan / BscScan / Polygonscan / Solscan.
              </p>
              {reconcileMsg ? (
                <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: 'var(--np-success)' }}>
                  {reconcileMsg}
                </p>
              ) : null}
            </div>
            <Button onClick={handleReconcile} loading={reconciling}>
              Reconciliar ahora
            </Button>
          </div>
        </Card>
      ) : null}

      {/* Split por método */}
      <Card style={{ padding: '1.25rem' }}>
        <h3 style={sectionTitle}>Payouts por método</h3>
        <div style={splitGrid}>
          {Object.entries(stats.byMethod).map(([method, count]) => (
            <SplitTile
              key={method}
              label={method === 'UNSET' ? 'No configurado' : PAYOUT_METHOD_LABELS[method as keyof typeof PAYOUT_METHOD_LABELS] ?? method}
              count={count}
            />
          ))}
          {Object.keys(stats.byMethod).length === 0 ? (
            <p style={{ color: 'var(--np-text-dim)', fontSize: '0.85rem', margin: 0 }}>
              Sin payouts todavía.
            </p>
          ) : null}
        </div>
      </Card>

      {/* Split por reconciliationStatus */}
      <Card style={{ padding: '1.25rem' }}>
        <h3 style={sectionTitle}>Estado de reconciliación</h3>
        <div style={splitGrid}>
          {Object.entries(stats.byReconciliationStatus).map(([status, count]) => (
            <SplitTile key={status} label={status} count={count} variant={statusVariant(status)} />
          ))}
        </div>
      </Card>
    </div>
  );
}

function MetricTile({
  title,
  value,
  unit,
  subtitle,
  highlight,
}: {
  title: string;
  value: string;
  unit?: string;
  subtitle?: string;
  highlight?: boolean;
}) {
  return (
    <Card variant={highlight ? 'glow' : 'default'} style={{ padding: '1.25rem 1.5rem' }}>
      <p style={metricLabel}>{title}</p>
      <p
        className="np-num"
        style={{
          ...metricValue,
          color: highlight ? 'var(--np-accent)' : 'var(--np-text)',
        }}
      >
        {value}
        {unit ? <span style={metricUnit}>{unit}</span> : null}
      </p>
      {subtitle ? <p style={metricSubtitle}>{subtitle}</p> : null}
    </Card>
  );
}

function SplitTile({ label, count, variant }: { label: string; count: number; variant?: 'success' | 'warning' | 'danger' | 'neutral' }) {
  const colors: Record<string, string> = {
    success: 'var(--np-success)',
    warning: 'var(--np-warning, #f59e0b)',
    danger: 'var(--np-danger)',
    neutral: 'var(--np-text)',
  };
  const color = colors[variant ?? 'neutral'];
  return (
    <div style={{
      border: '1px solid var(--np-border)',
      borderRadius: 'var(--np-r-md)',
      padding: '0.75rem 1rem',
      minWidth: 0,
    }}>
      <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--np-text-mute)' }}>{label}</p>
      <p className="np-num" style={{ margin: '0.25rem 0 0', fontSize: '1.5rem', fontWeight: 600, color }}>
        {count}
      </p>
    </div>
  );
}

function statusVariant(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'MATCHED' || status === 'MANUAL_OK') return 'success';
  if (status === 'MISMATCH') return 'danger';
  if (status === 'UNRECONCILED') return 'warning';
  return 'neutral';
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

const metricsGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(13rem, 1fr))',
  gap: '1rem',
};

const splitGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))',
  gap: '0.75rem',
  marginTop: '0.75rem',
};

const metricLabel: CSSProperties = {
  margin: 0,
  fontSize: '0.7rem',
  color: 'var(--np-text-dim)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 500,
};

const metricValue: CSSProperties = {
  margin: '0.5rem 0 0',
  fontSize: '1.875rem',
  fontWeight: 600,
  letterSpacing: '-0.02em',
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.4rem',
};

const metricUnit: CSSProperties = {
  fontSize: '0.875rem',
  color: 'var(--np-text-mute)',
  fontWeight: 500,
  letterSpacing: '0.04em',
};

const metricSubtitle: CSSProperties = {
  margin: '0.4rem 0 0',
  fontSize: '0.78rem',
  color: 'var(--np-text-dim)',
};

const sectionTitle: CSSProperties = {
  margin: 0,
  fontSize: '1rem',
  fontWeight: 600,
  letterSpacing: '-0.01em',
};

const loadingText: CSSProperties = {
  textAlign: 'center',
  color: 'var(--np-text-dim)',
  padding: '3rem 1rem',
  margin: 0,
};
