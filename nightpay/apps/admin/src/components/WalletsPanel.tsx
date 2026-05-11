'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button, Card, Modal, Select } from '@nightpay/ui';
import {
  fetchWalletsList,
  fetchWalletsStats,
  refundWallet,
  type WalletAdminRow,
  type WalletsAdminStats,
} from '@/lib/api';

const STATUS_FILTERS: Array<{ value: '' | WalletAdminRow['status']; label: string }> = [
  { value: '', label: 'Todas' },
  { value: 'ACTIVE', label: '🟢 Activas' },
  { value: 'DEPLETED', label: '⚪ Agotadas' },
  { value: 'REFUNDED', label: '🔵 Reembolsadas' },
  { value: 'EXPIRED', label: '🔴 Expiradas' },
];

interface Props {
  isOwner: boolean;
}

export function WalletsPanel({ isOwner }: Props) {
  const [stats, setStats] = useState<WalletsAdminStats | null>(null);
  const [rows, setRows] = useState<WalletAdminRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<'' | WalletAdminRow['status']>('ACTIVE');
  const [error, setError] = useState<string | null>(null);
  const [refundFor, setRefundFor] = useState<WalletAdminRow | null>(null);

  async function reload() {
    try {
      const [s, list] = await Promise.all([
        fetchWalletsStats(),
        fetchWalletsList({
          status: statusFilter === '' ? undefined : statusFilter,
        }),
      ]);
      setStats(s);
      setRows(list);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    reload();
    const id = setInterval(reload, 15_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  if (error) {
    return (
      <Card style={{ padding: '1rem', borderColor: 'var(--np-danger)' }}>
        <p style={{ color: 'var(--np-danger)', margin: 0 }}>{error}</p>
      </Card>
    );
  }
  if (!stats) return <p style={loadingStyle}>Cargando wallets…</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Tiles de stats */}
      <section style={tilesGrid}>
        <Tile
          title="Wallets activas"
          value={String(stats.activeCount)}
          subtitle={`${(stats.totalBalanceCents / 100).toFixed(2)} € total`}
        />
        <Tile
          title="Top-ups hoy"
          value={(stats.todayTopUpsCents / 100).toFixed(2)}
          unit="EUR"
        />
        <Tile
          title="Consumido hoy"
          value={(stats.todayConsumptionsCents / 100).toFixed(2)}
          unit="EUR"
        />
        <Tile
          title="Reembolsos hoy"
          value={(stats.todayRefundsCents / 100).toFixed(2)}
          unit="EUR"
        />
      </section>

      {/* Split por categoría */}
      {Object.keys(stats.byCategory).length > 0 ? (
        <Card style={{ padding: '1rem' }}>
          <h3 style={sectionTitle}>Consumos por categoría (hoy)</h3>
          <ul style={categoryList}>
            {Object.entries(stats.byCategory).map(([cat, cents]) => (
              <li key={cat} style={categoryItem}>
                <span style={{ textTransform: 'capitalize' }}>{cat}</span>
                <span className="np-num" style={{ fontWeight: 600 }}>
                  {(cents / 100).toFixed(2)} €
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* Lista de wallets */}
      <Card style={{ padding: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h3 style={sectionTitle}>Lista de wallets</h3>
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as '' | WalletAdminRow['status'])}
            style={{ width: '12rem' }}
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </Select>
        </div>

        {rows.length === 0 ? (
          <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--np-text-dim)' }}>
            Sin wallets para este filtro.
          </p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={theadRow}>
                <th style={th}>Identifier</th>
                <th style={th}>Status</th>
                <th style={thRight}>Balance</th>
                <th style={thRight}>Consumos</th>
                <th style={th}>Creada</th>
                {isOwner ? <th style={th}>Acciones</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id} style={trStyle}>
                  <td style={td}>{w.identifier ?? <em style={{ color: 'var(--np-text-dim)' }}>anónimo</em>}</td>
                  <td style={td}>
                    <StatusBadge status={w.status} />
                  </td>
                  <td style={tdRight}>
                    <span className="np-num">{(w.balanceCents / 100).toFixed(2)} €</span>
                  </td>
                  <td style={tdRight}>{w.consumptionCount}</td>
                  <td style={td}>
                    {new Date(w.createdAt).toLocaleString('es-ES', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  {isOwner ? (
                    <td style={td}>
                      {w.status === 'ACTIVE' && w.balanceCents > 0 ? (
                        <Button
                          variant="ghost"
                          onClick={() => setRefundFor(w)}
                        >
                          Refund
                        </Button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {refundFor ? (
        <RefundModal
          wallet={refundFor}
          onClose={() => setRefundFor(null)}
          onDone={() => {
            setRefundFor(null);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

function StatusBadge({ status }: { status: WalletAdminRow['status'] }) {
  const map: Record<WalletAdminRow['status'], { label: string; color: string }> = {
    ACTIVE: { label: '🟢 Activa', color: 'var(--np-success)' },
    DEPLETED: { label: '⚪ Agotada', color: 'var(--np-text-mute)' },
    REFUNDED: { label: '🔵 Reembolsada', color: 'var(--np-accent)' },
    EXPIRED: { label: '🔴 Expirada', color: 'var(--np-danger)' },
  };
  const d = map[status];
  return <span style={{ color: d.color, fontSize: '0.8rem', fontWeight: 500 }}>{d.label}</span>;
}

function RefundModal({
  wallet,
  onClose,
  onDone,
}: {
  wallet: WalletAdminRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [method, setMethod] = useState<'CARD' | 'CREDIT'>('CARD');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await refundWallet(wallet.id, { method, notes: notes.trim() || undefined });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Refund wallet">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ padding: '0.75rem 1rem', background: 'var(--np-surface-2)', borderRadius: 'var(--np-r-md)' }}>
          <p style={{ margin: 0, fontSize: '0.85rem' }}>
            Saldo a reembolsar: <strong className="np-num">{(wallet.balanceCents / 100).toFixed(2)} €</strong>
          </p>
        </div>
        <div>
          <label style={selectLabelStyle}>Método</label>
          <Select value={method} onChange={(e) => setMethod(e.target.value as 'CARD' | 'CREDIT')}>
            <option value="CARD">Tarjeta original (REFUNDED)</option>
            <option value="CREDIT">Crédito futuro +30 días (ACTIVE)</option>
          </Select>
          <p style={{ margin: '0.4rem 0 0', fontSize: '0.78rem', color: 'var(--np-text-mute)' }}>
            {method === 'CARD'
              ? '⚠️ La gestión del PSP refund real se hace fuera de aquí por ahora. Marca contable.'
              : '✅ Mantiene la wallet activa, balance intacto, extiende expiración 30 días.'}
          </p>
        </div>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notas opcionales..."
          rows={3}
          style={textareaStyle}
        />
        {error ? <p style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.85rem' }}>{error}</p> : null}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button onClick={handleSubmit} loading={submitting}>
            Confirmar refund
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Tile({
  title,
  value,
  unit,
  subtitle,
}: {
  title: string;
  value: string;
  unit?: string;
  subtitle?: string;
}) {
  return (
    <Card style={{ padding: '1rem' }}>
      <p style={kicker}>{title}</p>
      <p className="np-num" style={tileNumber}>
        {value}
        {unit ? <span style={tileUnit}> {unit}</span> : null}
      </p>
      {subtitle ? <p style={tileSub}>{subtitle}</p> : null}
    </Card>
  );
}

const tilesGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))',
  gap: '0.75rem',
};

const sectionTitle: CSSProperties = {
  margin: 0,
  fontSize: '0.9rem',
  fontWeight: 600,
  letterSpacing: '-0.01em',
};

const categoryList: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(8rem, 1fr))',
  gap: '0.5rem',
};

const categoryItem: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  padding: '0.45rem 0.7rem',
  background: 'var(--np-surface-2)',
  borderRadius: 'var(--np-r-md)',
  border: '1px solid var(--np-border)',
  fontSize: '0.85rem',
};

const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '0.85rem',
};

const theadRow: CSSProperties = {
  borderBottom: '1px solid var(--np-border)',
  color: 'var(--np-text-mute)',
};

const th: CSSProperties = {
  padding: '0.5rem 0.6rem',
  textAlign: 'left',
  fontSize: '0.72rem',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  fontWeight: 500,
};

const thRight: CSSProperties = { ...th, textAlign: 'right' };

const trStyle: CSSProperties = {
  borderBottom: '1px solid var(--np-border)',
};

const td: CSSProperties = {
  padding: '0.55rem 0.6rem',
};

const tdRight: CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

const kicker: CSSProperties = {
  margin: 0,
  fontSize: '0.7rem',
  color: 'var(--np-text-dim)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 500,
};

const tileNumber: CSSProperties = {
  margin: '0.3rem 0 0',
  fontSize: '1.4rem',
  fontWeight: 600,
  letterSpacing: '-0.02em',
  fontVariantNumeric: 'tabular-nums',
};

const tileUnit: CSSProperties = {
  fontSize: '0.75rem',
  color: 'var(--np-text-mute)',
  fontWeight: 500,
  letterSpacing: '0.05em',
};

const tileSub: CSSProperties = {
  margin: '0.2rem 0 0',
  fontSize: '0.75rem',
  color: 'var(--np-text-mute)',
};

const selectLabelStyle: CSSProperties = {
  display: 'block',
  fontSize: '0.8125rem',
  fontWeight: 500,
  color: 'var(--np-text-mute)',
  marginBottom: '0.375rem',
};

const textareaStyle: CSSProperties = {
  width: '100%',
  background: 'var(--np-bg)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  padding: '0.625rem 0.875rem',
  fontSize: '0.875rem',
  color: 'var(--np-text)',
  fontFamily: 'inherit',
  resize: 'vertical',
};

const loadingStyle: CSSProperties = {
  margin: 0,
  textAlign: 'center',
  fontSize: '0.85rem',
  color: 'var(--np-text-mute)',
};
