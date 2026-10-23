'use client';

import { useState, type CSSProperties } from 'react';
import { Button, Card } from '@nightpay/ui';
import {
  fetchExchangeRate,
  fetchTreasuryStats,
  reconcilePending,
  type ReconciliationStatus,
  type TreasuryStats,
} from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { keepIfSame } from '@/lib/diff';
import { formatDecimal, formatEur } from '@/lib/money';
import { RECONCILIATION_LABELS } from '@/lib/payout-verify';
import { usePolling } from '@/lib/use-polling';
import { useVenueTimezone } from '@/lib/venue-context';
import { Notice } from './Notice';
import { PAYOUT_METHOD_LABELS } from './PayoutMethodForm';

interface Props {
  isOwner: boolean;
}

const POLL_MS = 30_000;

type Rate = { rate: number; at: string; degraded: boolean } | 'unavailable';

/**
 * Tesorería: lo pendiente de pagar a las chicas y la tasa EUR→USDT. Si la
 * tasa falla, solo falta la tasa (antes se caía el panel entero); si fallan
 * las cifras, se avisa encima y se siguen viendo las últimas.
 */
export function TreasuryPanel({ isOwner }: Props) {
  const tz = useVenueTimezone();
  const [stats, setStats] = useState<TreasuryStats | null>(null);
  const [rate, setRate] = useState<Rate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = usePolling(
    async (signal) => {
      const [s, r] = await Promise.allSettled([fetchTreasuryStats(), fetchExchangeRate()]);
      if (signal.aborted) return true;
      if (r.status === 'fulfilled') {
        const next: Rate = { rate: r.value.rate, at: r.value.at, degraded: r.value.degraded };
        setRate((prev) => keepIfSame(prev, next));
      } else {
        setRate('unavailable');
      }
      if (s.status === 'fulfilled') {
        const next = s.value;
        setStats((prev) => keepIfSame(prev, next));
        setError(null);
        return true;
      }
      setError((s.reason as Error).message);
      return false;
    },
    { intervalMs: POLL_MS },
    [],
  );

  async function handleReconcile() {
    setReconciling(true);
    setReconcileResult(null);
    try {
      const result = await reconcilePending();
      setReconcileResult({ ok: true, text: `Reconciliación: ${result.matched}/${result.checked} verificados.` });
      reload();
    } catch (err) {
      setReconcileResult({ ok: false, text: `No se pudo reconciliar: ${(err as Error).message}` });
    } finally {
      setReconciling(false);
    }
  }

  const liveRate = rate && rate !== 'unavailable' ? rate : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {error ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: reload }}>
          {error}
          {stats ? ' · se siguen enseñando los últimos datos.' : ''}
        </Notice>
      ) : null}

      {stats === null ? (
        error ? null : <p style={loadingText}>Cargando treasury…</p>
      ) : (
        <>
          <section style={metricsGrid}>
            <MetricTile
              title="Saldo pendiente a chicas"
              value={formatEur(stats.pendingPayoutsCents)}
              subtitle={pendingSubtitle(stats)}
              highlight
            />
            <MetricTile
              title="Pagos este mes"
              value={String(stats.payoutsThisMonthCount)}
              subtitle={formatEur(stats.payoutsThisMonthCents)}
            />
            <MetricTile
              title={liveRate?.degraded ? 'EUR → USDT (aproximada)' : 'EUR → USDT (Binance)'}
              value={liveRate ? formatDecimal(liveRate.rate, 4) : '—'}
              unit={liveRate ? 'USDT' : undefined}
              subtitle={
                rate === 'unavailable'
                  ? 'Tasa no disponible ahora'
                  : liveRate
                    ? liveRate.degraded
                      ? 'Binance no responde: último valor bueno o de reserva'
                      : `Actualizado ${formatDateTime(liveRate.at, tz, 'time')}`
                    : ''
              }
            />
            <MetricTile
              title="USDT necesarios (pendiente)"
              value={liveRate ? formatDecimal((stats.pendingPayoutsCents / 100) * liveRate.rate, 2) : '—'}
              unit={liveRate ? 'USDT' : undefined}
              subtitle={liveRate ? 'Para liquidar todos los pendientes' : 'Sin tasa no se calcula'}
            />
          </section>

          {isOwner ? (
            <Card style={{ padding: '1.25rem' }}>
              <div style={reconcileRow}>
                <div>
                  <h3 style={sectionTitle}>Reconciliación on-chain</h3>
                  <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--np-text-mute)' }}>
                    Recorre los pagos sin verificar con hash on-chain y reintenta contra Tronscan / BscScan /
                    Polygonscan / Solscan.
                  </p>
                  {reconcileResult ? (
                    <p
                      role={reconcileResult.ok ? 'status' : 'alert'}
                      style={{
                        margin: '0.5rem 0 0',
                        fontSize: '0.85rem',
                        color: reconcileResult.ok ? 'var(--np-success)' : 'var(--np-danger)',
                      }}
                    >
                      {reconcileResult.text}
                    </p>
                  ) : null}
                </div>
                <Button onClick={handleReconcile} loading={reconciling}>
                  Reconciliar ahora
                </Button>
              </div>
            </Card>
          ) : null}

          <Card style={{ padding: '1.25rem' }}>
            <h3 style={sectionTitle}>Payouts por método</h3>
            <div style={splitGrid}>
              {Object.entries(stats.byMethod).map(([method, count]) => (
                <SplitTile
                  key={method}
                  label={
                    method === 'UNSET'
                      ? 'No configurado'
                      : (PAYOUT_METHOD_LABELS[method as keyof typeof PAYOUT_METHOD_LABELS] ?? method)
                  }
                  count={count}
                />
              ))}
              {Object.keys(stats.byMethod).length === 0 ? (
                <p style={{ color: 'var(--np-text-dim)', fontSize: '0.85rem', margin: 0 }}>Sin payouts todavía.</p>
              ) : null}
            </div>
          </Card>

          <Card style={{ padding: '1.25rem' }}>
            <h3 style={sectionTitle}>Estado de reconciliación</h3>
            <div style={splitGrid}>
              {Object.entries(stats.byReconciliationStatus).map(([status, count]) => (
                <SplitTile key={status} label={reconciliationLabel(status)} count={count} variant={statusVariant(status)} />
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

/** Chicas con algo que cobrar ya y, con el API nuevo, lo que está en espera y la deuda. */
function pendingSubtitle(stats: TreasuryStats): string {
  const parts = [`${stats.pendingOperatorCount} chica${stats.pendingOperatorCount === 1 ? '' : 's'}`];
  if (stats.heldPayoutsCents) parts.push(`${formatEur(stats.heldPayoutsCents)} en espera`);
  if (stats.operatorDebtCents) parts.push(`deuda por devoluciones ${formatEur(stats.operatorDebtCents)}`);
  return parts.join(' · ');
}

function reconciliationLabel(status: string): string {
  return RECONCILIATION_LABELS[status as ReconciliationStatus]?.label ?? status;
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

function SplitTile({
  label,
  count,
  variant,
}: {
  label: string;
  count: number;
  variant?: 'success' | 'warning' | 'danger' | 'neutral';
}) {
  const colors: Record<string, string> = {
    success: 'var(--np-success)',
    warning: 'var(--np-warning)',
    danger: 'var(--np-danger)',
    neutral: 'var(--np-text)',
  };
  const color = colors[variant ?? 'neutral'];
  return (
    <div
      style={{
        border: '1px solid var(--np-border)',
        borderRadius: 'var(--np-r-md)',
        padding: '0.75rem 1rem',
        minWidth: 0,
      }}
    >
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

const reconcileRow: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  flexWrap: 'wrap',
  gap: '1rem',
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
  // Cifra grande del panel: Manrope 800, como los importes (las de las tablas, 700).
  fontWeight: 800,
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
