'use client';

import { useEffect, useState } from 'react';
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
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    reload();
    const interval = setInterval(reload, 5000); // poll cada 5s
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function logout() {
    await apiLogout();
    onLogout();
  }

  return (
    <main style={pageStyle}>
      <header style={headerStyle}>
        <strong>NightPay Admin</strong>
        <span style={{ color: '#666', marginLeft: '1rem' }}>
          {user.email} · venue <code>{user.venueSlug}</code> · rol {user.role}
        </span>
        <button onClick={logout} style={logoutBtnStyle}>
          Salir
        </button>
      </header>

      {error && <p style={errStyle}>{error}</p>}

      <section style={metricsRow}>
        <MetricTile title="Hoy: pagos" value={metrics?.today.count ?? '—'} />
        <MetricTile
          title="Hoy: bruto"
          value={metrics ? `${(metrics.today.grossCents / 100).toFixed(2)} €` : '—'}
        />
        <MetricTile
          title="Hoy: reembolsos"
          value={metrics ? `${(metrics.today.refundedCents / 100).toFixed(2)} €` : '—'}
        />
        <MetricTile
          title="Hoy: neto"
          value={metrics ? `${(metrics.today.netCents / 100).toFixed(2)} €` : '—'}
          highlight
        />
        <MetricTile
          title="Semana: neto"
          value={metrics ? `${(metrics.week.netCents / 100).toFixed(2)} €` : '—'}
        />
      </section>

      <section style={{ marginTop: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
          <h2 style={{ margin: 0 }}>Pagos recientes</h2>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} style={selectStyle}>
            <option value="">Todos</option>
            <option value="CREATED">CREATED</option>
            <option value="AUTHORIZING">AUTHORIZING</option>
            <option value="AUTHORIZED">AUTHORIZED</option>
            <option value="FAILED">FAILED</option>
            <option value="EXPIRED">EXPIRED</option>
            <option value="REFUNDED">REFUNDED</option>
            <option value="PARTIALLY_REFUNDED">PARTIALLY_REFUNDED</option>
            <option value="ORPHAN">ORPHAN</option>
          </select>
          <button onClick={reload} style={refreshBtn}>
            Refrescar
          </button>
        </div>

        <table style={tableStyle}>
          <thead>
            <tr style={{ background: '#f7f7f8' }}>
              <th style={th}>Hora</th>
              <th style={th}>Importe</th>
              <th style={th}>Disponible</th>
              <th style={th}>Estado</th>
              <th style={th}>Terminal</th>
              <th style={th}>Provider</th>
              <th style={th}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={td}>{new Date(p.createdAt).toLocaleString('es-ES')}</td>
                <td style={td}>
                  {(p.amountCents / 100).toFixed(2)} {p.currency}
                </td>
                <td style={td}>{(p.availableAmountCents / 100).toFixed(2)}</td>
                <td style={{ ...td, fontWeight: 600 }}>
                  <StatusBadge status={p.status} />
                </td>
                <td style={td}>{p.terminal.label}</td>
                <td style={td}>{p.provider ?? '—'}</td>
                <td style={td}>
                  {(p.status === 'AUTHORIZED' || p.status === 'PARTIALLY_REFUNDED') &&
                    p.availableAmountCents > 0 &&
                    (user.role === 'OWNER' || user.role === 'MANAGER') && (
                      <button onClick={() => setRefundFor(p)} style={refundBtnStyle}>
                        Reembolsar
                      </button>
                    )}
                </td>
              </tr>
            ))}
            {payments.length === 0 && (
              <tr>
                <td colSpan={7} style={{ ...td, textAlign: 'center', color: '#999' }}>
                  Sin pagos
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {refundFor && (
        <RefundModal
          payment={refundFor}
          onClose={() => setRefundFor(null)}
          onDone={() => {
            setRefundFor(null);
            reload();
          }}
        />
      )}
    </main>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; fg: string }> = {
    CREATED: { bg: '#e3f2fd', fg: '#1565c0' },
    AWAITING_CAPTURE: { bg: '#e3f2fd', fg: '#1565c0' },
    AUTHORIZING: { bg: '#fff3e0', fg: '#e65100' },
    AUTHORIZED: { bg: '#e8f5e9', fg: '#2e7d32' },
    FAILED: { bg: '#ffebee', fg: '#c62828' },
    EXPIRED: { bg: '#fafafa', fg: '#616161' },
    REFUNDED: { bg: '#f3e5f5', fg: '#6a1b9a' },
    PARTIALLY_REFUNDED: { bg: '#f3e5f5', fg: '#6a1b9a' },
    ORPHAN: { bg: '#fff3e0', fg: '#e65100' },
  };
  const c = colors[status] ?? { bg: '#eee', fg: '#333' };
  return (
    <span
      style={{
        background: c.bg,
        color: c.fg,
        padding: '0.2rem 0.6rem',
        borderRadius: '999px',
        fontSize: '0.75rem',
      }}
    >
      {status}
    </span>
  );
}

function MetricTile({
  title,
  value,
  highlight,
}: {
  title: string;
  value: string | number;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        padding: '1.25rem 1.5rem',
        background: highlight ? '#1a1a1f' : '#fff',
        color: highlight ? '#fafafa' : '#1a1a1f',
        border: '1px solid #e0e0e0',
        borderRadius: '0.75rem',
        minWidth: '10rem',
      }}
    >
      <p style={{ margin: 0, fontSize: '0.8rem', color: highlight ? '#aaa' : '#666' }}>{title}</p>
      <p style={{ margin: '0.4rem 0 0', fontSize: '1.6rem', fontWeight: 700 }}>{value}</p>
    </div>
  );
}

function RefundModal({
  payment,
  onClose,
  onDone,
}: {
  payment: PaymentRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState((payment.availableAmountCents / 100).toFixed(2));
  const [reason, setReason] = useState('');
  const [totp, setTotp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = Math.round(parseFloat(amount.replace(',', '.')) * 100);
  const requires2FA = cents >= 100_00;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (!Number.isFinite(cents) || cents <= 0) throw new Error('Importe inválido');
      if (cents > payment.availableAmountCents)
        throw new Error('Excede el importe disponible');
      await refundPayment(payment.id, cents, reason || undefined, requires2FA ? totp : undefined);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div onClick={onClose} style={overlayStyle}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit} style={modalStyle}>
        <h3 style={{ margin: 0 }}>Reembolsar pago</h3>
        <p style={{ margin: '0.5rem 0', color: '#666', fontSize: '0.85rem' }}>
          ID {payment.id} · disponible {(payment.availableAmountCents / 100).toFixed(2)} €
        </p>
        <label style={lbl}>Importe (€)</label>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
          style={modalInput}
        />
        <label style={lbl}>Razón (opcional)</label>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          style={modalInput}
        />
        {requires2FA && (
          <>
            <label style={lbl}>Código TOTP (6 dígitos)</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              required
              style={modalInput}
            />
            <p style={{ fontSize: '0.75rem', color: '#999', margin: 0 }}>
              Reembolsos ≥ 100 € exigen 2FA (placeholder: cualquier 6 dígitos por ahora).
            </p>
          </>
        )}
        {error && <p style={errStyle}>{error}</p>}
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button type="button" onClick={onClose} style={cancelBtn}>
            Cancelar
          </button>
          <button type="submit" disabled={submitting} style={confirmBtn}>
            {submitting ? 'Procesando…' : 'Confirmar reembolso'}
          </button>
        </div>
      </form>
    </div>
  );
}

// styles ──
const pageStyle: React.CSSProperties = { padding: '1.5rem', minHeight: '100vh' };
const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  paddingBottom: '1rem',
  borderBottom: '1px solid #e0e0e0',
};
const logoutBtnStyle: React.CSSProperties = {
  marginLeft: 'auto',
  padding: '0.4rem 0.9rem',
  fontSize: '0.85rem',
  background: 'transparent',
  color: '#666',
  border: '1px solid #ccc',
  borderRadius: '0.4rem',
  cursor: 'pointer',
};
const metricsRow: React.CSSProperties = {
  display: 'flex',
  gap: '1rem',
  flexWrap: 'wrap',
  marginTop: '1.5rem',
};
const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  background: '#fff',
  borderRadius: '0.5rem',
  overflow: 'hidden',
  border: '1px solid #e0e0e0',
};
const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '0.75rem 1rem',
  fontSize: '0.8rem',
  color: '#666',
  textTransform: 'uppercase',
};
const td: React.CSSProperties = { padding: '0.75rem 1rem', fontSize: '0.9rem' };
const refreshBtn: React.CSSProperties = {
  padding: '0.4rem 0.9rem',
  background: '#fff',
  border: '1px solid #ccc',
  borderRadius: '0.4rem',
  cursor: 'pointer',
};
const refundBtnStyle: React.CSSProperties = {
  padding: '0.3rem 0.7rem',
  fontSize: '0.8rem',
  background: '#fff3e0',
  color: '#e65100',
  border: '1px solid #ffb74d',
  borderRadius: '0.3rem',
  cursor: 'pointer',
};
const selectStyle: React.CSSProperties = {
  padding: '0.4rem 0.7rem',
  border: '1px solid #ccc',
  borderRadius: '0.4rem',
  background: '#fff',
};
const errStyle: React.CSSProperties = {
  background: '#ffebee',
  color: '#c62828',
  padding: '0.7rem 1rem',
  borderRadius: '0.4rem',
  margin: '1rem 0',
};
const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
};
const modalStyle: React.CSSProperties = {
  background: '#fff',
  padding: '1.5rem',
  borderRadius: '0.75rem',
  width: '100%',
  maxWidth: '24rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
};
const lbl: React.CSSProperties = { fontSize: '0.8rem', color: '#666', marginTop: '0.5rem' };
const modalInput: React.CSSProperties = {
  padding: '0.6rem 0.8rem',
  fontSize: '1rem',
  border: '1px solid #ccc',
  borderRadius: '0.4rem',
};
const cancelBtn: React.CSSProperties = {
  flex: 1,
  padding: '0.7rem',
  background: '#fff',
  border: '1px solid #ccc',
  borderRadius: '0.4rem',
  cursor: 'pointer',
};
const confirmBtn: React.CSSProperties = {
  flex: 1,
  padding: '0.7rem',
  background: '#1a1a1f',
  color: '#fafafa',
  border: 'none',
  borderRadius: '0.4rem',
  cursor: 'pointer',
};
