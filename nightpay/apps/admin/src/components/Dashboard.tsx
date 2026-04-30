'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import {
  Button,
  Card,
  Input,
  Modal,
  Select,
  StatusPill,
  ThemeToggle,
  type PaymentStatus,
} from '@nightpay/ui';
import {
  fetchMetrics,
  fetchPayments,
  logout as apiLogout,
  refundPayment,
  type Metrics,
  type PaymentRow,
  type User,
} from '@/lib/api';

interface Props {
  user: User;
  onLogout: () => void;
}

export function Dashboard({ user, onLogout }: Props) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [filter, setFilter] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [refundFor, setRefundFor] = useState<PaymentRow | null>(null);

  async function reload() {
    try {
      const statusList = filter ? [filter] : undefined;
      const [m, p] = await Promise.all([
        fetchMetrics(),
        fetchPayments({ status: statusList, limit: 50 }),
      ]);
      setMetrics(m);
      setPayments(p.items);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    reload();
    const interval = setInterval(reload, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function logout() {
    await apiLogout();
    onLogout();
  }

  return (
    <main
      className="np-app-root"
      style={{
        minHeight: '100dvh',
        padding: '2rem',
        maxWidth: '88rem',
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '2rem',
      }}
    >
      <header style={headerStyle}>
        <div>
          <p style={brandKicker}>NightPay</p>
          <h1 style={brandTitle}>Admin</h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{ textAlign: 'right' }}>
            <p style={userEmail}>{user.email}</p>
            <p style={userMeta}>
              <code style={code}>{user.venueSlug}</code> · {user.role}
            </p>
          </div>
          <ThemeToggle />
          <Button variant="ghost" onClick={logout}>
            Salir
          </Button>
        </div>
      </header>

      {error ? (
        <Card style={{ padding: '1rem', borderColor: 'var(--np-danger)' }}>
          <p style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>{error}</p>
        </Card>
      ) : null}

      <section style={metricsGrid}>
        <MetricTile title="Hoy · pagos" value={metrics?.today.count ?? '—'} />
        <MetricTile
          title="Hoy · bruto"
          value={fmt(metrics?.today.grossCents)}
          unit="EUR"
        />
        <MetricTile
          title="Hoy · reembolsos"
          value={fmt(metrics?.today.refundedCents)}
          unit="EUR"
        />
        <MetricTile
          title="Hoy · neto"
          value={fmt(metrics?.today.netCents)}
          unit="EUR"
          highlight
        />
        <MetricTile
          title="Semana · neto"
          value={fmt(metrics?.week.netCents)}
          unit="EUR"
        />
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: '1rem',
            flexWrap: 'wrap',
          }}
        >
          <h2 style={sectionTitle}>Pagos recientes</h2>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <div style={{ minWidth: '12rem' }}>
              <Select value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="">Todos los estados</option>
                <option value="CREATED">CREATED</option>
                <option value="AUTHORIZING">AUTHORIZING</option>
                <option value="AUTHORIZED">AUTHORIZED</option>
                <option value="FAILED">FAILED</option>
                <option value="EXPIRED">EXPIRED</option>
                <option value="REFUNDED">REFUNDED</option>
                <option value="PARTIALLY_REFUNDED">PARTIALLY_REFUNDED</option>
                <option value="ORPHAN">ORPHAN</option>
              </Select>
            </div>
            <Button variant="ghost" onClick={reload}>
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
                  <th>Provider</th>
                  <th style={{ textAlign: 'right' }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => {
                  const canRefund =
                    (p.status === 'AUTHORIZED' || p.status === 'PARTIALLY_REFUNDED') &&
                    p.availableAmountCents > 0 &&
                    (user.role === 'OWNER' || user.role === 'MANAGER');
                  return (
                    <tr key={p.id}>
                      <td style={cellMeta}>{formatTime(p.createdAt)}</td>
                      <td className="np-num" style={numCell}>
                        {(p.amountCents / 100).toFixed(2)} {p.currency}
                      </td>
                      <td className="np-num" style={numCell}>
                        {(p.availableAmountCents / 100).toFixed(2)}
                      </td>
                      <td>
                        <StatusPill status={p.status as PaymentStatus} size="sm" />
                      </td>
                      <td style={cellMeta}>{p.terminal.label}</td>
                      <td style={cellMeta}>{p.provider ?? '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        {canRefund ? (
                          <Button variant="ghost" onClick={() => setRefundFor(p)} size="md" style={{ height: '2.25rem', padding: '0 1rem', fontSize: '0.8125rem' }}>
                            Reembolsar
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
                {payments.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={emptyCell}>
                      Sin pagos
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
      </section>

      <RefundModal
        open={Boolean(refundFor)}
        payment={refundFor}
        onClose={() => setRefundFor(null)}
        onDone={() => {
          setRefundFor(null);
          reload();
        }}
      />
    </main>
  );
}

function fmt(cents: number | undefined): string {
  if (cents === undefined) return '—';
  return (cents / 100).toFixed(2);
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

function MetricTile({
  title,
  value,
  unit,
  highlight,
}: {
  title: string;
  value: string | number;
  unit?: string;
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
        {unit && value !== '—' ? <span style={metricUnit}>{unit}</span> : null}
      </p>
    </Card>
  );
}

function RefundModal({
  open,
  payment,
  onClose,
  onDone,
}: {
  open: boolean;
  payment: PaymentRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [totp, setTotp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (payment) {
      setAmount((payment.availableAmountCents / 100).toFixed(2));
      setReason('');
      setTotp('');
      setError(null);
    }
  }, [payment]);

  if (!payment) {
    return <Modal open={open} onClose={onClose}>{null}</Modal>;
  }

  const cents = Math.round(parseFloat(amount.replace(',', '.')) * 100);
  const requires2FA = Number.isFinite(cents) && cents >= 100_00;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!payment) return;
    setSubmitting(true);
    setError(null);
    try {
      if (!Number.isFinite(cents) || cents <= 0) throw new Error('Importe inválido');
      if (cents > payment.availableAmountCents) throw new Error('Excede el importe disponible');
      await refundPayment(payment.id, cents, reason || undefined, requires2FA ? totp : undefined);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Reembolsar pago">
      <p style={refundMeta}>
        ID <code style={code}>{payment.id.slice(0, 8)}…</code> · disponible{' '}
        <span className="np-num">{(payment.availableAmountCents / 100).toFixed(2)} €</span>
      </p>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1.25rem' }}>
        <Input
          label="Importe (€)"
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
          size="lg"
          style={{ fontFamily: 'var(--np-font-mono)' }}
        />
        <Input
          label="Razón (opcional)"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
        />
        {requires2FA ? (
          <Input
            label="Código TOTP (6 dígitos)"
            type="text"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
            required
            hint="Reembolsos ≥ 100 € exigen 2FA (placeholder: 6 dígitos cualquiera)."
          />
        ) : null}
        {error ? (
          <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
            {error}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
          <Button variant="ghost" type="button" onClick={onClose} style={{ flex: 1 }}>
            Cancelar
          </Button>
          <Button type="submit" loading={submitting} style={{ flex: 1 }}>
            Confirmar reembolso
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  paddingBottom: '1rem',
  borderBottom: '1px solid var(--np-border)',
  flexWrap: 'wrap',
  gap: '1rem',
};

const brandKicker: CSSProperties = {
  margin: 0,
  fontSize: '0.7rem',
  color: 'var(--np-text-dim)',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  fontWeight: 500,
};

const brandTitle: CSSProperties = {
  margin: '0.25rem 0 0',
  fontSize: 'var(--np-t-h1)',
  fontWeight: 600,
  letterSpacing: '-0.03em',
  color: 'var(--np-text)',
};

const userEmail: CSSProperties = {
  margin: 0,
  fontSize: '0.875rem',
  fontWeight: 500,
  color: 'var(--np-text)',
};

const userMeta: CSSProperties = {
  margin: '0.25rem 0 0',
  fontSize: '0.75rem',
  color: 'var(--np-text-mute)',
};

const code: CSSProperties = {
  fontFamily: 'var(--np-font-mono)',
  background: 'var(--np-surface-2)',
  padding: '0.1rem 0.4rem',
  borderRadius: '4px',
  fontSize: '0.75rem',
};

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

const metricUnit: CSSProperties = {
  fontSize: '0.875rem',
  color: 'var(--np-text-mute)',
  fontWeight: 500,
  letterSpacing: '0.04em',
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

const refundMeta: CSSProperties = {
  margin: 0,
  fontSize: '0.8125rem',
  color: 'var(--np-text-mute)',
};
