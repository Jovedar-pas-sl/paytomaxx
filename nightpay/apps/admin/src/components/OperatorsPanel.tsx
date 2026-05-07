'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input, Modal } from '@nightpay/ui';
import {
  createOperator,
  createOperatorPayout,
  fetchOperatorEarnings,
  fetchOperatorPayouts,
  fetchOperators,
  updateOperator,
  type Operator,
  type OperatorEarning,
  type OperatorPayout,
} from '@/lib/api';

interface Props {
  isOwner: boolean;
}

export function OperatorsPanel({ isOwner }: Props) {
  const [operators, setOperators] = useState<Operator[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [createResult, setCreateResult] = useState<{ inviteUrl: string; emailSent: boolean } | null>(
    null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);

  async function reload() {
    try {
      const list = await fetchOperators();
      setOperators(list);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    const int = setInterval(reload, 10000);
    return () => clearInterval(int);
  }, []);

  const selected = operators.find((o) => o.id === selectedId) ?? null;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <h2 style={sectionTitle}>Operadoras</h2>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.75rem' }}>
          <Button variant="ghost" onClick={reload}>
            Refrescar
          </Button>
          <Button onClick={() => setCreateOpen(true)}>+ Nueva operadora</Button>
        </div>
      </div>

      {error ? (
        <Card style={{ padding: '1rem', borderColor: 'var(--np-danger)' }}>
          <p style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>{error}</p>
        </Card>
      ) : null}

      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="np-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Email</th>
                <th style={numCol}>Comisión</th>
                <th style={numCol}>Saldo pendiente</th>
                <th style={numCol}>Pagado total</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} style={emptyCell}>
                    Cargando…
                  </td>
                </tr>
              ) : operators.length === 0 ? (
                <tr>
                  <td colSpan={7} style={emptyCell}>
                    Aún no hay operadoras. Crea la primera con "+ Nueva operadora".
                  </td>
                </tr>
              ) : (
                operators.map((op) => (
                  <tr
                    key={op.id}
                    onClick={() => setSelectedId(op.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>{op.displayName ?? '—'}</td>
                    <td style={cellMeta}>{op.email}</td>
                    <td className="np-num" style={numCell}>
                      {(op.commissionBps / 100).toFixed(2)} %
                    </td>
                    <td
                      className="np-num"
                      style={{
                        ...numCell,
                        color: op.balance.pendingCents < 0 ? 'var(--np-danger)' : 'var(--np-text)',
                      }}
                    >
                      {(op.balance.pendingCents / 100).toFixed(2)} €
                    </td>
                    <td className="np-num" style={numCell}>
                      {(op.balance.paidCents / 100).toFixed(2)} €
                    </td>
                    <td style={cellMeta}>
                      {op.active ? (op.invitedAt ? 'Invitada' : 'Activa') : 'Inactiva'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Button
                        variant="ghost"
                        size="md"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedId(op.id);
                        }}
                        style={{ height: '2.25rem', padding: '0 1rem', fontSize: '0.8125rem' }}
                      >
                        Ver
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <CreateOperatorModal
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setCreateResult(null);
        }}
        onCreated={(result) => {
          setCreateResult(result);
          reload();
        }}
        result={createResult}
      />

      {selected ? (
        <OperatorDetailModal
          operator={selected}
          isOwner={isOwner}
          onClose={() => setSelectedId(null)}
          onChanged={reload}
        />
      ) : null}
    </section>
  );
}

function CreateOperatorModal({
  open,
  onClose,
  onCreated,
  result,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (r: { inviteUrl: string; emailSent: boolean }) => void;
  result: { inviteUrl: string; emailSent: boolean } | null;
}) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [commissionPct, setCommissionPct] = useState('15');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open && !result) {
      setEmail('');
      setDisplayName('');
      setCommissionPct('15');
      setError(null);
      setCopied(false);
    }
  }, [open, result]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const pct = parseFloat(commissionPct.replace(',', '.'));
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error('Comisión inválida');
      const res = await createOperator({
        email: email.trim().toLowerCase(),
        displayName: displayName.trim(),
        commissionBps: Math.round(pct * 100),
      });
      onCreated({ inviteUrl: res.inviteUrl, emailSent: res.emailSent });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Nueva operadora" width="32rem">
      {result ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <p style={{ margin: 0, fontSize: '0.95rem' }}>
            ✅ Operadora creada.{' '}
            {result.emailSent
              ? 'Email de invitación enviado.'
              : 'No hay SMTP configurado — copia el link y mándaselo por WhatsApp.'}
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'stretch' }}>
            <code style={urlCode}>{result.inviteUrl}</code>
            <Button variant="ghost" size="md" onClick={copy}>
              {copied ? '✓ Copiado' : 'Copiar'}
            </Button>
          </div>
          <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--np-text-dim)' }}>
            El link es válido durante 24 h y se invalida tras el primer uso.
          </p>
          <Button onClick={onClose}>Cerrar</Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <Input
            label="Nombre"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            placeholder="Ana"
          />
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="ana@ejemplo.com"
          />
          <Input
            label="Comisión (%)"
            type="text"
            inputMode="decimal"
            value={commissionPct}
            onChange={(e) => setCommissionPct(e.target.value)}
            required
            hint="Ejemplo: 15 = 15%"
          />
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
              Crear y generar invite
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function OperatorDetailModal({
  operator,
  isOwner,
  onClose,
  onChanged,
}: {
  operator: Operator;
  isOwner: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [earnings, setEarnings] = useState<OperatorEarning[]>([]);
  const [payouts, setPayouts] = useState<OperatorPayout[]>([]);
  const [tab, setTab] = useState<'earnings' | 'payouts' | 'edit'>('earnings');
  const [error, setError] = useState<string | null>(null);
  const [payoutOpen, setPayoutOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchOperatorEarnings(operator.id), fetchOperatorPayouts(operator.id)])
      .then(([e, p]) => {
        if (cancelled) return;
        setEarnings(e);
        setPayouts(p);
      })
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [operator.id]);

  const balance = operator.balance.pendingCents;

  return (
    <Modal open onClose={onClose} title={operator.displayName ?? operator.email} width="40rem">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: '0.75rem',
            padding: '1rem',
            background: 'var(--np-surface)',
            borderRadius: 'var(--np-r-md)',
          }}
        >
          <span style={{ fontSize: '0.7rem', color: 'var(--np-text-dim)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Saldo pendiente
          </span>
          <span
            className="np-num"
            style={{
              fontSize: '1.75rem',
              fontWeight: 600,
              marginLeft: 'auto',
              color: balance < 0 ? 'var(--np-danger)' : 'var(--np-success)',
            }}
          >
            {(balance / 100).toFixed(2)} €
          </span>
          {isOwner && balance > 0 ? (
            <Button onClick={() => setPayoutOpen(true)} size="md">
              Marcar pagado
            </Button>
          ) : null}
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', borderBottom: '1px solid var(--np-border)' }}>
          {(['earnings', 'payouts', 'edit'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                background: 'transparent',
                border: 'none',
                color: tab === t ? 'var(--np-accent)' : 'var(--np-text-mute)',
                padding: '0.5rem 1rem',
                fontWeight: 500,
                borderBottom: tab === t ? '2px solid var(--np-accent)' : '2px solid transparent',
                cursor: 'pointer',
              }}
            >
              {t === 'earnings' ? 'Ganancias' : t === 'payouts' ? 'Liquidaciones' : 'Editar'}
            </button>
          ))}
        </div>

        {error ? <p style={{ color: 'var(--np-danger)', margin: 0 }}>{error}</p> : null}

        {tab === 'earnings' ? (
          <EarningsTable earnings={earnings} />
        ) : tab === 'payouts' ? (
          <PayoutsTable payouts={payouts} />
        ) : (
          <EditOperatorForm operator={operator} onSaved={() => { onChanged(); onClose(); }} />
        )}
      </div>

      {payoutOpen ? (
        <PayoutConfirmModal
          operatorId={operator.id}
          balanceCents={balance}
          onClose={() => setPayoutOpen(false)}
          onDone={() => {
            setPayoutOpen(false);
            onChanged();
            onClose();
          }}
        />
      ) : null}
    </Modal>
  );
}

function EarningsTable({ earnings }: { earnings: OperatorEarning[] }) {
  if (earnings.length === 0) {
    return <p style={emptyText}>Aún no hay ganancias.</p>;
  }
  return (
    <div style={{ maxHeight: '24rem', overflowY: 'auto' }}>
      <table className="np-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th style={numCol}>Importe</th>
            <th style={numCol}>Comisión</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          {earnings.map((e) => (
            <tr key={e.id}>
              <td style={cellMeta}>{new Date(e.createdAt).toLocaleString('es-ES')}</td>
              <td className="np-num" style={numCell}>
                {(e.paymentAmountCents / 100).toFixed(2)} €
              </td>
              <td className="np-num" style={{ ...numCell, color: e.netCents < e.commissionCents ? 'var(--np-warning)' : 'var(--np-text)' }}>
                {(e.netCents / 100).toFixed(2)} €{' '}
                {e.reversedCents > 0 ? `(−${(e.reversedCents / 100).toFixed(2)})` : ''}
              </td>
              <td style={cellMeta}>{e.payoutId ? 'Liquidada' : 'Pendiente'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PayoutsTable({ payouts }: { payouts: OperatorPayout[] }) {
  if (payouts.length === 0) {
    return <p style={emptyText}>Aún no hay liquidaciones.</p>;
  }
  return (
    <div style={{ maxHeight: '24rem', overflowY: 'auto' }}>
      <table className="np-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th style={numCol}>Total</th>
            <th style={numCol}>Earnings</th>
            <th>Pagado por</th>
          </tr>
        </thead>
        <tbody>
          {payouts.map((p) => (
            <tr key={p.id}>
              <td style={cellMeta}>{new Date(p.createdAt).toLocaleString('es-ES')}</td>
              <td className="np-num" style={numCell}>
                {(p.totalCents / 100).toFixed(2)} €
              </td>
              <td className="np-num" style={numCell}>
                {p.earningCount}
              </td>
              <td style={cellMeta}>{p.paidByEmail ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EditOperatorForm({ operator, onSaved }: { operator: Operator; onSaved: () => void }) {
  const [displayName, setDisplayName] = useState(operator.displayName ?? '');
  const [commissionPct, setCommissionPct] = useState((operator.commissionBps / 100).toFixed(2));
  const [active, setActive] = useState(operator.active);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const pct = parseFloat(commissionPct.replace(',', '.'));
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error('Comisión inválida');
      await updateOperator(operator.id, {
        displayName,
        commissionBps: Math.round(pct * 100),
        active,
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <Input
        label="Nombre"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
      />
      <Input
        label="Comisión (%)"
        type="text"
        inputMode="decimal"
        value={commissionPct}
        onChange={(e) => setCommissionPct(e.target.value)}
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem' }}>
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Activa (puede crear cobros)
      </label>
      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
          {error}
        </p>
      ) : null}
      <Button type="submit" loading={submitting}>
        Guardar
      </Button>
    </form>
  );
}

function PayoutConfirmModal({
  operatorId,
  balanceCents,
  onClose,
  onDone,
}: {
  operatorId: string;
  balanceCents: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createOperatorPayout(operatorId, notes || undefined);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Marcar pagado" width="28rem">
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <p style={{ margin: 0, fontSize: '0.95rem' }}>
          Vas a marcar como pagado el saldo pendiente:{' '}
          <strong className="np-num">{(balanceCents / 100).toFixed(2)} €</strong>
        </p>
        <Input
          label="Notas (opcional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Pagado en efectivo, recibo #..."
          maxLength={500}
        />
        {error ? (
          <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
            {error}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <Button variant="ghost" type="button" onClick={onClose} style={{ flex: 1 }}>
            Cancelar
          </Button>
          <Button type="submit" loading={submitting} style={{ flex: 1 }}>
            Confirmar liquidación
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const sectionTitle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-h2)',
  fontWeight: 600,
  letterSpacing: '-0.02em',
};

const numCol: CSSProperties = { textAlign: 'right' };
const numCell: CSSProperties = { textAlign: 'right', fontWeight: 500 };
const cellMeta: CSSProperties = { color: 'var(--np-text-mute)' };
const emptyCell: CSSProperties = {
  textAlign: 'center',
  color: 'var(--np-text-dim)',
  padding: '3rem 1rem',
  fontSize: '0.875rem',
};
const emptyText: CSSProperties = {
  textAlign: 'center',
  color: 'var(--np-text-dim)',
  padding: '2rem 1rem',
  margin: 0,
};
const urlCode: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  padding: '0 0.875rem',
  fontFamily: 'var(--np-font-mono)',
  fontSize: '0.7rem',
  background: 'var(--np-bg)',
  color: 'var(--np-text-mute)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  overflowX: 'auto',
  whiteSpace: 'nowrap',
  height: '3rem',
  minWidth: 0,
};
