'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import {
  Button,
  Card,
  Input,
  Logo,
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
  resolveStuckPayment,
  type Metrics,
  type PaymentRow,
  type User,
} from '@/lib/api';
import { BankRefundModal } from './BankRefundModal';
import { CartaPanel } from './CartaPanel';
import { NightsPanel } from './NightsPanel';
import { OperatorsPanel } from './OperatorsPanel';
import { ReportsPanel } from './ReportsPanel';
import { SettingsPanel } from './SettingsPanel';
import { TerminalsPanel } from './TerminalsPanel';
import { TreasuryPanel } from './TreasuryPanel';
import { WalletsPanel } from './WalletsPanel';
import { VenuesPanel } from './VenuesPanel';
import { VenueSwitcher } from './VenueSwitcher';

interface Props {
  user: User;
  onLogout: () => void;
}

type TabKey =
  | 'payments'
  | 'nights'
  | 'operators'
  | 'carta'
  | 'reports'
  | 'wallets'
  | 'treasury'
  | 'terminals'
  | 'settings'
  | 'venues';

export function Dashboard({ user, onLogout }: Props) {
  const [tab, setTab] = useState<TabKey>('payments');
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [filter, setFilter] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [refundFor, setRefundFor] = useState<PaymentRow | null>(null);
  const [resolveFor, setResolveFor] = useState<PaymentRow | null>(null);

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
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
          <Logo height="2.25rem" />
          <div style={{ borderLeft: '1px solid var(--np-border)', paddingLeft: '1.25rem' }}>
            <p style={brandKicker}>Panel</p>
            <h1 style={brandTitle}>Admin</h1>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {user.isSuperAdmin ? <VenueSwitcher currentSlug={user.venueSlug} /> : null}
          <div style={{ textAlign: 'right' }}>
            <p style={userEmail}>{user.email}</p>
            <p style={userMeta}>
              <code style={code}>{user.venueSlug}</code> · {user.role}
              {user.isSuperAdmin ? ' · SUPER' : ''}
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

      <nav style={tabNavStyle}>
        <TabButton active={tab === 'payments'} onClick={() => setTab('payments')}>
          Pagos
        </TabButton>
        <TabButton active={tab === 'nights'} onClick={() => setTab('nights')}>
          Noches
        </TabButton>
        <TabButton active={tab === 'operators'} onClick={() => setTab('operators')}>
          Operadoras
        </TabButton>
        <TabButton active={tab === 'carta'} onClick={() => setTab('carta')}>
          Carta
        </TabButton>
        <TabButton active={tab === 'reports'} onClick={() => setTab('reports')}>
          Informes
        </TabButton>
        <TabButton active={tab === 'wallets'} onClick={() => setTab('wallets')}>
          Wallets
        </TabButton>
        <TabButton active={tab === 'treasury'} onClick={() => setTab('treasury')}>
          Treasury
        </TabButton>
        <TabButton active={tab === 'terminals'} onClick={() => setTab('terminals')}>
          Datáfonos
        </TabButton>
        <TabButton active={tab === 'settings'} onClick={() => setTab('settings')}>
          Ajustes
        </TabButton>
        {user.isSuperAdmin ? (
          <TabButton active={tab === 'venues'} onClick={() => setTab('venues')}>
            Locales
          </TabButton>
        ) : null}
      </nav>

      {tab === 'nights' ? (
        <NightsPanel isOwner={user.role === 'OWNER'} />
      ) : tab === 'operators' ? (
        <OperatorsPanel isOwner={user.role === 'OWNER'} />
      ) : tab === 'carta' ? (
        <CartaPanel />
      ) : tab === 'reports' ? (
        <ReportsPanel isOwner={user.role === 'OWNER'} />
      ) : tab === 'wallets' ? (
        <WalletsPanel isOwner={user.role === 'OWNER'} />
      ) : tab === 'treasury' ? (
        <TreasuryPanel isOwner={user.role === 'OWNER'} />
      ) : tab === 'terminals' ? (
        <TerminalsPanel isOwner={user.role === 'OWNER'} />
      ) : tab === 'settings' ? (
        <SettingsPanel isOwner={user.role === 'OWNER'} />
      ) : tab === 'venues' && user.isSuperAdmin ? (
        <VenuesPanel currentSlug={user.venueSlug} />
      ) : (
      <>
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
                  <th>Banco</th>
                  <th style={{ textAlign: 'right' }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => {
                  // Redsys: se devuelve en el portal de BBVA y se apunta aquí (solo el dueño).
                  const bankRefund = p.provider === 'REDSYS';
                  const canRefund =
                    (p.status === 'AUTHORIZED' || p.status === 'PARTIALLY_REFUNDED') &&
                    p.availableAmountCents > 0 &&
                    (user.role === 'OWNER' || (!bankRefund && user.role === 'MANAGER'));
                  const canResolve = user.role === 'OWNER' && isStuck(p);
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
                      <td style={cellMeta}>{bankSummary(p)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {canResolve ? (
                          <Button onClick={() => setResolveFor(p)} size="md" style={{ height: '2.25rem', padding: '0 1rem', fontSize: '0.8125rem' }}>
                            Resolver
                          </Button>
                        ) : null}
                        {canRefund ? (
                          <Button variant="ghost" onClick={() => setRefundFor(p)} size="md" style={{ height: '2.25rem', padding: '0 1rem', fontSize: '0.8125rem' }}>
                            {bankRefund ? 'Devolución BBVA' : 'Reembolsar'}
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

      <ResolveModal
        payment={resolveFor}
        onClose={() => setResolveFor(null)}
        onDone={() => {
          setResolveFor(null);
          reload();
        }}
      />

      <BankRefundModal
        payment={refundFor?.provider === 'REDSYS' ? refundFor : null}
        onClose={() => setRefundFor(null)}
        onDone={() => {
          setRefundFor(null);
          reload();
        }}
      />

      <RefundModal
        open={Boolean(refundFor) && refundFor?.provider !== 'REDSYS'}
        payment={refundFor?.provider === 'REDSYS' ? null : refundFor}
        onClose={() => setRefundFor(null)}
        onDone={() => {
          setRefundFor(null);
          reload();
        }}
      />
      </>
      )}
    </main>
  );
}

function TabButton({
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
        background: 'transparent',
        border: 'none',
        color: active ? 'var(--np-accent)' : 'var(--np-text-mute)',
        padding: '0.625rem 1.25rem',
        fontWeight: 500,
        fontSize: '0.95rem',
        borderBottom: active ? '2px solid var(--np-accent)' : '2px solid transparent',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

const tabNavStyle: CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  borderBottom: '1px solid var(--np-border)',
};

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

const STUCK_AUTHORIZING_MS = 15 * 60 * 1000;

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

function ResolveModal({
  payment,
  onClose,
  onDone,
}: {
  payment: PaymentRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [decision, setDecision] = useState<'AUTHORIZED' | 'FAILED'>('AUTHORIZED');
  const [authCode, setAuthCode] = useState('');
  const [bankOrder, setBankOrder] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (payment) {
      setDecision('AUTHORIZED');
      setAuthCode('');
      setBankOrder('');
      setReason('');
      setError(null);
    }
  }, [payment]);

  if (!payment) {
    return <Modal open={false} onClose={onClose}>{null}</Modal>;
  }

  // Fase 1B: si los intentos llevaban propinas distintas, hay que decir cuál
  // cobró el banco (la propina es de la chica). Los denegados no cuentan.
  const attempts = payment.attempts ?? [];
  const chargeable = attempts.filter((a) => a.status !== 'DENIED');
  const tipsDiffer = new Set(chargeable.map((a) => a.tipCents ?? null)).size > 1;
  const needsOrder = decision === 'AUTHORIZED' && tipsDiffer;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!payment) return;
    setError(null);
    const code = authCode.replace(/\s+/g, '').toUpperCase();
    if (decision === 'AUTHORIZED' && !/^[A-Z0-9]{6}$/.test(code)) {
      setError('Pon el código de autorización del banco: 6 letras o números.');
      return;
    }
    if (needsOrder && !bankOrder) {
      setError('Elige el pedido que aparece cobrado en el portal del banco.');
      return;
    }
    if (reason.trim().length < 3) {
      setError('Explica brevemente cómo lo has comprobado.');
      return;
    }
    setSubmitting(true);
    try {
      await resolveStuckPayment(payment.id, {
        decision,
        reason: reason.trim(),
        ...(decision === 'AUTHORIZED' ? { bankAuthCode: code } : {}),
        ...(needsOrder ? { bankOrder } : {}),
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Resolver cobro">
      <p style={refundMeta}>
        <span className="np-num">{(payment.amountCents / 100).toFixed(2)} {payment.currency}</span>
        {' · '}{formatTime(payment.createdAt)}
        {payment.providerTxId ? <> · pedido <code style={code}>{payment.providerTxId}</code></> : null}
      </p>
      {payment.attempts && payment.attempts.length > 0 ? (
        <ul style={{ ...refundMeta, margin: '0.5rem 0 0', paddingLeft: '1.1rem' }}>
          {payment.attempts.map((a) => (
            <li key={a.providerTxId}>
              Pedido <code style={code}>{a.providerTxId}</code> · {formatTime(a.createdAt)} ·{' '}
              {a.amountCents != null ? <span className="np-num">{(a.amountCents / 100).toFixed(2)} € · </span> : null}
              {a.status === 'APPROVED' ? 'aprobado' : a.status === 'DENIED' ? 'denegado' : 'sin respuesta'}
            </li>
          ))}
        </ul>
      ) : null}
      <p style={{ ...refundMeta, marginTop: '0.5rem' }}>
        Búscalo en el portal del banco por importe, hora o número de pedido.
      </p>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1.25rem' }}>
        <div role="radiogroup" aria-label="¿Se cobró?" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.5rem' }}>
          <Button
            type="button"
            variant={decision === 'AUTHORIZED' ? 'primary' : 'ghost'}
            aria-pressed={decision === 'AUTHORIZED'}
            onClick={() => setDecision('AUTHORIZED')}
          >
            Sí, se cobró
          </Button>
          <Button
            type="button"
            variant={decision === 'FAILED' ? 'primary' : 'ghost'}
            aria-pressed={decision === 'FAILED'}
            onClick={() => setDecision('FAILED')}
          >
            No se cobró
          </Button>
        </div>
        {decision === 'AUTHORIZED' ? (
          <Input
            label="Código de autorización del banco"
            value={authCode}
            onChange={(e) => setAuthCode(e.target.value)}
            placeholder="ej: 047215"
            maxLength={8}
            autoCapitalize="characters"
            required
          />
        ) : null}
        {needsOrder ? (
          <Select
            label="¿Qué pedido cobró el banco?"
            value={bankOrder}
            onChange={(e) => setBankOrder(e.target.value)}
            required
          >
            <option value="">Elige el pedido del portal del banco</option>
            {chargeable.map((a) => (
              <option key={a.providerTxId} value={a.providerTxId}>
                {a.providerTxId}
                {a.amountCents != null ? ` · ${(a.amountCents / 100).toFixed(2)} €` : ''}
                {a.tipCents ? ` (propina ${(a.tipCents / 100).toFixed(2)} €)` : ''}
              </option>
            ))}
          </Select>
        ) : null}
        <Input
          label="Cómo lo has comprobado"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="ej: aparece en el portal BBVA a las 09:50"
          maxLength={500}
          required
        />
        {error ? <p role="alert" style={{ color: 'var(--np-danger)', margin: 0 }}>{error}</p> : null}
        <Button type="submit" loading={submitting}>
          {decision === 'AUTHORIZED' ? 'Marcar como cobrado' : 'Marcar como no cobrado'}
        </Button>
      </form>
    </Modal>
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
