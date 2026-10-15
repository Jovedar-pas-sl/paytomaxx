'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button, Card, Select, StatusPill, type PaymentStatus } from '@nightpay/ui';
import { fetchMetrics, fetchPayments, type Metrics, type PaymentRow, type User } from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { formatEur, formatMoney } from '@/lib/money';
import { appendPage, mergeLatestPage } from '@/lib/pagination';
import { usePolling } from '@/lib/use-polling';
import { useVenueTimezone } from '@/lib/venue-context';
import { BankRefundModal } from './BankRefundModal';
import { RefundModal, ResolveModal } from './PaymentModals';

const PAGE_SIZE = 50;
/** Tope de `limit` en GET /v1/admin/payments. */
const MAX_PAGE_SIZE = 200;
const POLL_MS = 5000;
const MAX_POLL_MS = 60_000;

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Todos los estados' },
  { value: 'CREATED', label: 'Creado' },
  { value: 'AUTHORIZING', label: 'Esperando pago' },
  { value: 'AUTHORIZED', label: 'Pagado' },
  { value: 'FAILED', label: 'Rechazado' },
  { value: 'EXPIRED', label: 'Caducado' },
  { value: 'REFUNDED', label: 'Devuelto' },
  { value: 'PARTIALLY_REFUNDED', label: 'Devuelto en parte' },
  { value: 'ORPHAN', label: 'Sin confirmar' },
];

const STUCK_AUTHORIZING_MS = 15 * 60 * 1000;

/**
 * Pestaña Pagos: métricas y últimos cobros. Solo pide datos mientras está a
 * la vista (pestaña del panel y del navegador), espera más si el API falla y
 * una respuesta vieja no pisa la de un filtro nuevo.
 */
export function PaymentsPanel({ user }: { user: User }) {
  const tz = useVenueTimezone();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  /** null = aún no ha llegado la primera página. */
  const [payments, setPayments] = useState<PaymentRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refundFor, setRefundFor] = useState<PaymentRow | null>(null);
  const [resolveFor, setResolveFor] = useState<PaymentRow | null>(null);
  // Filas cargadas (el refresco pide las mismas) y filtro vigente (para
  // descartar un "Cargar más" que vuelve después de cambiar el filtro).
  const loadedRef = useRef(0);
  const filterRef = useRef(filter);

  useEffect(() => {
    loadedRef.current = payments?.length ?? 0;
  }, [payments]);

  const refresh = usePolling(
    async (signal) => {
      const loaded = loadedRef.current;
      const limit = Math.min(MAX_PAGE_SIZE, Math.max(PAGE_SIZE, loaded));
      try {
        const [m, page] = await Promise.all([
          fetchMetrics(),
          fetchPayments({ status: filter ? [filter] : undefined, limit }),
        ]);
        if (signal.aborted) return true;
        setMetrics(m);
        setPayments((prev) => (prev ? mergeLatestPage(page.items, prev) : page.items));
        // Si entretanto se cargó otra página, su cursor es el bueno.
        if (loaded <= MAX_PAGE_SIZE && loaded === loadedRef.current) setNextCursor(page.nextCursor);
        setError(null);
        return true;
      } catch (err) {
        if (!signal.aborted) setError((err as Error).message);
        return false;
      }
    },
    { intervalMs: POLL_MS, maxIntervalMs: MAX_POLL_MS },
    [filter],
  );

  function changeFilter(value: string): void {
    filterRef.current = value;
    loadedRef.current = 0;
    setPayments(null);
    setNextCursor(null);
    setFilter(value);
  }

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    const forFilter = filter;
    setLoadingMore(true);
    try {
      const page = await fetchPayments({
        status: forFilter ? [forFilter] : undefined,
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      if (filterRef.current !== forFilter) return;
      setPayments((prev) => appendPage(prev ?? [], page.items));
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  function afterAction(close: () => void): () => void {
    return () => {
      close();
      refresh();
    };
  }

  return (
    <>
      {error ? (
        <Card style={{ padding: '1rem', borderColor: 'var(--np-danger)' }}>
          <div style={errorRow}>
            <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
              {error}
              {payments ? ' · se siguen enseñando los últimos datos.' : ''}
            </p>
            <Button variant="ghost" onClick={refresh} style={smallBtn}>
              Reintentar
            </Button>
          </div>
        </Card>
      ) : null}

      <section style={metricsGrid}>
        <MetricTile title="Hoy · pagos" value={metrics ? String(metrics.today.count) : '—'} />
        <MetricTile title="Hoy · bruto" value={eurOrDash(metrics?.today.grossCents)} />
        <MetricTile title="Hoy · reembolsos" value={eurOrDash(metrics?.today.refundedCents)} />
        <MetricTile title="Hoy · neto" value={eurOrDash(metrics?.today.netCents)} highlight />
        <MetricTile title="Semana · neto" value={eurOrDash(metrics?.week.netCents)} />
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '1rem', flexWrap: 'wrap' }}>
          <h2 style={sectionTitle}>Pagos recientes</h2>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <div style={{ minWidth: '12rem' }}>
              <Select aria-label="Filtrar por estado" value={filter} onChange={(e) => changeFilter(e.target.value)}>
                {STATUS_FILTERS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </div>
            <Button variant="ghost" onClick={refresh}>
              Refrescar
            </Button>
          </div>
        </div>

        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="np-table">
              <thead>
                <tr>
                  <th>Hora</th>
                  <th style={numCol}>Importe</th>
                  <th style={numCol}>Disponible</th>
                  <th>Estado</th>
                  <th>Terminal</th>
                  <th>Banco</th>
                  <th style={{ textAlign: 'right' }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {(payments ?? []).map((p) => {
                  // Redsys: se devuelve en el portal de BBVA y se apunta aquí (solo el dueño).
                  const bankRefund = p.provider === 'REDSYS';
                  const canRefund =
                    (p.status === 'AUTHORIZED' || p.status === 'PARTIALLY_REFUNDED') &&
                    p.availableAmountCents > 0 &&
                    (user.role === 'OWNER' || (!bankRefund && user.role === 'MANAGER'));
                  const canResolve = user.role === 'OWNER' && isStuck(p);
                  return (
                    <tr key={p.id}>
                      <td style={cellMeta}>{formatDateTime(p.createdAt, tz, 'short')}</td>
                      <td className="np-num" style={numCell}>
                        {formatMoney(p.amountCents, p.currency)}
                      </td>
                      <td className="np-num" style={numCell}>
                        {formatMoney(p.availableAmountCents, p.currency)}
                      </td>
                      <td>
                        <StatusPill status={p.status as PaymentStatus} size="sm" />
                      </td>
                      <td style={cellMeta}>{p.terminal.label}</td>
                      <td style={cellMeta}>{bankSummary(p)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {canResolve ? (
                          <Button onClick={() => setResolveFor(p)} size="md" style={smallBtn}>
                            Resolver
                          </Button>
                        ) : null}
                        {canRefund ? (
                          <Button variant="ghost" onClick={() => setRefundFor(p)} size="md" style={smallBtn}>
                            {bankRefund ? 'Devolución BBVA' : 'Reembolsar'}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
                {payments === null || payments.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={emptyCell}>
                      {payments === null ? (error ? 'No se pudieron cargar los pagos.' : 'Cargando pagos…') : 'Sin pagos'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>

        {payments && payments.length > 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <span style={{ ...cellMeta, fontSize: '0.8125rem' }}>
              {payments.length === 1 ? '1 pago' : `${payments.length} pagos`}
            </span>
            {nextCursor ? (
              <Button variant="ghost" onClick={() => void loadMore()} loading={loadingMore}>
                Cargar más
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      <ResolveModal
        payment={resolveFor}
        onClose={() => setResolveFor(null)}
        onDone={afterAction(() => setResolveFor(null))}
      />

      <BankRefundModal
        payment={refundFor?.provider === 'REDSYS' ? refundFor : null}
        onClose={() => setRefundFor(null)}
        onDone={afterAction(() => setRefundFor(null))}
      />

      <RefundModal
        open={Boolean(refundFor) && refundFor?.provider !== 'REDSYS'}
        payment={refundFor?.provider === 'REDSYS' ? null : refundFor}
        onClose={() => setRefundFor(null)}
        onDone={afterAction(() => setRefundFor(null))}
      />
    </>
  );
}

function eurOrDash(cents: number | undefined): string {
  return cents === undefined ? '—' : formatEur(cents);
}

/** Sin confirmar, o más de 15 min esperando al banco: se puede resolver a mano. */
function isStuck(p: PaymentRow): boolean {
  if (p.status === 'ORPHAN') return true;
  return p.status === 'AUTHORIZING' && Date.now() - Date.parse(p.updatedAt) >= STUCK_AUTHORIZING_MS;
}

/** Lo que identifica el cobro en el banco: código de autorización y tarjeta. */
function bankSummary(p: PaymentRow): string {
  const parts: string[] = [];
  if (p.provider) parts.push(p.provider);
  if (p.authCode) parts.push(`AUT ${p.authCode}`);
  if (p.cardLast4) parts.push(`••${p.cardLast4}`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function MetricTile({ title, value, highlight }: { title: string; value: string; highlight?: boolean }) {
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
      </p>
    </Card>
  );
}

const errorRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  flexWrap: 'wrap',
};

const smallBtn: CSSProperties = { height: '2.25rem', padding: '0 1rem', fontSize: '0.8125rem' };

const metricsGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))',
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
  fontWeight: 600,
  letterSpacing: '-0.02em',
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.4rem',
};

const sectionTitle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-h2)',
  fontWeight: 600,
  letterSpacing: '-0.02em',
};

const numCol: CSSProperties = { textAlign: 'right' };
const numCell: CSSProperties = { textAlign: 'right', fontWeight: 500 };

const cellMeta: CSSProperties = {
  color: 'var(--np-text-mute)',
};

const emptyCell: CSSProperties = {
  textAlign: 'center',
  color: 'var(--np-text-dim)',
  padding: '3rem 1rem',
  fontSize: '0.875rem',
};
