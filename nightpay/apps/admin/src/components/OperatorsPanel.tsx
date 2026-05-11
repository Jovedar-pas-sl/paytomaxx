'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input, Modal } from '@nightpay/ui';
import {
  confirmPayoutManual,
  createOperator,
  createOperatorPayout,
  fetchExchangeRate,
  fetchOperatorEarnings,
  fetchOperatorPayouts,
  fetchOperators,
  updateOperator,
  verifyPayout,
  type Operator,
  type OperatorEarning,
  type OperatorPayout,
  type PayoutMethod,
  type PayoutMetadata,
} from '@/lib/api';
import { PAYOUT_METHOD_LABELS, PayoutMethodForm } from './PayoutMethodForm';
import { OnboardingForm } from './OnboardingForm';

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
  const [filterNeedsHelp, setFilterNeedsHelp] = useState(false);

  const needsHelpCount = operators.filter(
    (o) => o.needsHelpWallet || o.needsHelpDocs,
  ).length;
  const visibleOperators = filterNeedsHelp
    ? operators.filter((o) => o.needsHelpWallet || o.needsHelpDocs)
    : operators;

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
        {needsHelpCount > 0 ? (
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '0.85rem',
              background: filterNeedsHelp ? 'var(--np-warning-bg, #fef3c7)' : 'var(--np-surface-2)',
              border: '1px solid var(--np-border)',
              borderRadius: 'var(--np-r-pill)',
              padding: '0.4rem 0.875rem',
              cursor: 'pointer',
              color: filterNeedsHelp ? '#78350f' : 'var(--np-text)',
            }}
          >
            <input
              type="checkbox"
              checked={filterNeedsHelp}
              onChange={(e) => setFilterNeedsHelp(e.target.checked)}
              style={{ margin: 0 }}
            />
            ⚠️ Solo las que necesitan ayuda ({needsHelpCount})
          </label>
        ) : null}
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
              ) : visibleOperators.length === 0 ? (
                <tr>
                  <td colSpan={7} style={emptyCell}>
                    {operators.length === 0
                      ? 'Aún no hay operadoras. Crea la primera con "+ Nueva operadora".'
                      : 'Ninguna coincide con el filtro.'}
                  </td>
                </tr>
              ) : (
                visibleOperators.map((op) => {
                  const needsHelp = op.needsHelpWallet || op.needsHelpDocs;
                  return (
                    <tr
                      key={op.id}
                      onClick={() => setSelectedId(op.id)}
                      style={{
                        cursor: 'pointer',
                        background: needsHelp ? 'var(--np-warning-bg, #fef3c7)' : undefined,
                      }}
                    >
                      <td>
                        {op.displayName ?? '—'}
                        {needsHelp ? (
                          <span
                            style={{
                              marginLeft: '0.5rem',
                              fontSize: '0.7rem',
                              color: '#78350f',
                              fontWeight: 600,
                            }}
                          >
                            ⚠️ ayuda
                          </span>
                        ) : null}
                      </td>
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
                        <OnboardingBadge operator={op} />
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
                  );
                })
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
  const [tab, setTab] = useState<'earnings' | 'payouts' | 'edit' | 'onboarding'>('earnings');
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

        <div style={{ display: 'flex', gap: '0.5rem', borderBottom: '1px solid var(--np-border)', flexWrap: 'wrap' }}>
          {(['earnings', 'payouts', 'edit', 'onboarding'] as const).map((t) => (
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
              {t === 'earnings'
                ? 'Ganancias'
                : t === 'payouts'
                  ? 'Liquidaciones'
                  : t === 'edit'
                    ? 'Editar'
                    : `Onboarding${operator.needsHelpWallet || operator.needsHelpDocs ? ' ⚠️' : ''}`}
            </button>
          ))}
        </div>

        {error ? <p style={{ color: 'var(--np-danger)', margin: 0 }}>{error}</p> : null}

        {tab === 'earnings' ? (
          <EarningsTable earnings={earnings} />
        ) : tab === 'payouts' ? (
          <PayoutsTable payouts={payouts} />
        ) : tab === 'edit' ? (
          <EditOperatorForm operator={operator} onSaved={() => { onChanged(); onClose(); }} />
        ) : (
          <OnboardingForm operator={operator} onSaved={onChanged} />
        )}
      </div>

      {payoutOpen ? (
        <PayoutConfirmModal
          operatorId={operator.id}
          balanceCents={balance}
          payoutMethod={operator.payoutMethod ?? null}
          payoutAddress={operator.payoutAddress ?? null}
          payoutLabel={operator.payoutLabel ?? null}
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
  const [payout, setPayout] = useState<{
    method: PayoutMethod | null;
    address: string | null;
    metadata: PayoutMetadata | null;
    label: string | null;
  }>({
    method: operator.payoutMethod ?? null,
    address: operator.payoutAddress ?? null,
    metadata: operator.payoutMetadata ?? null,
    label: operator.payoutLabel ?? null,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const pct = parseFloat(commissionPct.replace(',', '.'));
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error('Comisión inválida');
      // Validar que si hay method seleccionado, address esté informada (excepto MANUAL_CASH)
      if (payout.method && payout.method !== 'MANUAL_CASH' && !payout.address) {
        throw new Error('Falta la address/email/IBAN para el método seleccionado');
      }
      await updateOperator(operator.id, {
        displayName,
        commissionBps: Math.round(pct * 100),
        active,
        payoutMethod: payout.method,
        payoutAddress: payout.address,
        payoutMetadata: payout.metadata,
        payoutLabel: payout.label,
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

      <div style={{
        marginTop: '0.5rem',
        paddingTop: '1rem',
        borderTop: '1px solid var(--np-border)',
      }}>
        <h4 style={{
          margin: '0 0 0.75rem',
          fontSize: '0.7rem',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--np-text-dim)',
          fontWeight: 500,
        }}>
          Routing del payout (Phase 1A)
        </h4>
        <PayoutMethodForm
          method={payout.method}
          address={payout.address}
          metadata={payout.metadata}
          label={payout.label}
          onChange={setPayout}
          disabled={submitting}
        />
      </div>

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
  payoutMethod,
  payoutAddress,
  payoutLabel,
  onClose,
  onDone,
}: {
  operatorId: string;
  balanceCents: number;
  payoutMethod?: PayoutMethod | null;
  payoutAddress?: string | null;
  payoutLabel?: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [notes, setNotes] = useState('');
  const [externalTxId, setExternalTxId] = useState('');
  const [receiptUrl, setReceiptUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exchangeRate, setExchangeRate] = useState<{ rate: number } | null>(null);

  const isAutoVerifiable =
    payoutMethod &&
    ['USDT_TRC20', 'USDT_BEP20', 'USDC_POLY', 'USDC_SOL'].includes(payoutMethod);

  // Cargar tasa EUR→USDT solo si cripto
  useEffect(() => {
    if (!isAutoVerifiable) return;
    fetchExchangeRate()
      .then((r) => setExchangeRate({ rate: r.rate }))
      .catch(() => setExchangeRate({ rate: 1.07 }));
  }, [isAutoVerifiable]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // Crear el payout con referencia externa si la hay
      const created = await createOperatorPayout(operatorId, {
        notes: notes || undefined,
        externalTxId: externalTxId.trim() || undefined,
        externalRail: payoutMethod ?? undefined,
        receiptUrl: receiptUrl.trim() || undefined,
      });
      // Si admin pegó txhash + método cripto auto-verificable → llama verify
      if (externalTxId.trim() && isAutoVerifiable && payoutMethod) {
        try {
          await verifyPayout(created.id, {
            externalTxId: externalTxId.trim(),
            externalRail: payoutMethod,
            receiptUrl: receiptUrl.trim() || undefined,
          });
        } catch (verifyErr) {
          // Si la verificación falla, el payout sigue creado. Mostramos warning.
          // eslint-disable-next-line no-console
          console.warn('Auto-verify falló:', (verifyErr as Error).message);
        }
      } else if (!isAutoVerifiable && externalTxId.trim()) {
        // Método manual con referencia → admin puede marcar MANUAL_OK
        try {
          await confirmPayoutManual(created.id);
        } catch (confErr) {
          // eslint-disable-next-line no-console
          console.warn('Confirm manual falló:', (confErr as Error).message);
        }
      }
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const balanceEur = balanceCents / 100;
  const usdtEquiv = exchangeRate ? (balanceEur * exchangeRate.rate).toFixed(2) : null;

  return (
    <Modal open onClose={onClose} title="Marcar pagado" width="32rem">
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <p style={{ margin: 0, fontSize: '0.95rem' }}>
          Saldo pendiente a liquidar:{' '}
          <strong className="np-num">{balanceEur.toFixed(2)} €</strong>
          {usdtEquiv ? (
            <span style={{ color: 'var(--np-text-mute)', fontSize: '0.85rem', marginLeft: '0.5rem' }}>
              ≈ {usdtEquiv} USDT
            </span>
          ) : null}
        </p>

        {payoutMethod ? (
          <div style={{
            background: 'var(--np-surface-2)',
            border: '1px solid var(--np-border)',
            borderRadius: 'var(--np-r-md)',
            padding: '0.75rem 1rem',
            fontSize: '0.85rem',
          }}>
            <p style={{ margin: 0, color: 'var(--np-text-mute)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Método chica
            </p>
            <p style={{ margin: '0.25rem 0 0' }}>
              <strong>{PAYOUT_METHOD_LABELS[payoutMethod]}</strong>
            </p>
            {payoutAddress ? (
              <p style={{
                margin: '0.25rem 0 0',
                fontFamily: 'var(--np-font-mono)',
                fontSize: '0.78rem',
                color: 'var(--np-text-mute)',
                wordBreak: 'break-all',
              }}>
                {payoutAddress}
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(payoutAddress)}
                  style={{
                    marginLeft: '0.5rem',
                    background: 'none',
                    border: '1px solid var(--np-border)',
                    color: 'var(--np-text-mute)',
                    fontSize: '0.7rem',
                    padding: '0.15rem 0.5rem',
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                >
                  Copiar
                </button>
              </p>
            ) : null}
            {payoutLabel ? (
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.78rem', color: 'var(--np-text-dim)' }}>
                Alias: {payoutLabel}
              </p>
            ) : null}
          </div>
        ) : (
          <div style={{
            background: 'var(--np-warning-bg, #fef3c7)',
            border: '1px solid #fcd34d',
            borderRadius: 'var(--np-r-md)',
            padding: '0.75rem 1rem',
            fontSize: '0.85rem',
            color: '#78350f',
          }}>
            Esta chica no tiene método de payout configurado. Se marcará como MANUAL_CASH.
            Configura su método en "Edit" antes para usar verificación automática.
          </div>
        )}

        <Input
          label={isAutoVerifiable ? 'Hash de la transacción on-chain' : 'Referencia externa (receipt ID, SEPA ref, etc.)'}
          value={externalTxId}
          onChange={(e) => setExternalTxId(e.target.value)}
          placeholder={isAutoVerifiable ? '0x... o TxId Tron' : 'Receipt ID, número SEPA, etc.'}
          hint={isAutoVerifiable ? 'Se verificará automáticamente contra el explorer.' : 'Opcional. Si lo pegas se marca MANUAL_OK.'}
          maxLength={200}
        />
        <Input
          label="Receipt URL (opcional, screenshot)"
          value={receiptUrl}
          onChange={(e) => setReceiptUrl(e.target.value)}
          placeholder="https://..."
          maxLength={500}
        />
        <Input
          label="Notas (opcional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder='"Pagado vía Binance", "Wire SEPA enviado", etc.'
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

function OnboardingBadge({ operator }: { operator: Operator }) {
  const status = operator.onboardingStatus ?? 'NEW';
  const display: { label: string; color: string } = (() => {
    if (!operator.active) return { label: 'Inactiva', color: 'var(--np-text-dim)' };
    if (status === 'READY') return { label: '🟢 Operativa', color: 'var(--np-success)' };
    if (status === 'BLOCKED') return { label: '🔴 Bloqueada', color: 'var(--np-danger)' };
    if (status === 'BINANCE_PENDING') return { label: '🔵 KYC pending', color: 'var(--np-accent)' };
    if (status === 'INVITE_ACTIVATED') return { label: '🟠 Activada', color: 'var(--np-warning, #f59e0b)' };
    if (status === 'PROFILE_CREATED') {
      if (operator.invitedAt) return { label: '🟡 Invitada', color: 'var(--np-warning, #f59e0b)' };
      return { label: '🟡 Perfil creado', color: 'var(--np-warning, #f59e0b)' };
    }
    if (operator.invitedAt) return { label: '🟡 Invitada', color: 'var(--np-warning, #f59e0b)' };
    return { label: '⚪ Nueva', color: 'var(--np-text-mute)' };
  })();
  return (
    <span style={{ fontSize: '0.75rem', fontWeight: 500, color: display.color }}>
      {display.label}
    </span>
  );
}
