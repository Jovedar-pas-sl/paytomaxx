'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button, Modal } from '@nightpay/ui';
import {
  fetchOperatorEarnings,
  fetchOperatorPayouts,
  type Operator,
  type OperatorEarning,
  type OperatorPayout,
} from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { formatEur } from '@/lib/money';
import { RECONCILIATION_LABELS } from '@/lib/payout-verify';
import { safeHttpUrl } from '@/lib/urls';
import { useApprovals } from '@/lib/use-approvals';
import { useVenueTimezone } from '@/lib/venue-context';
import { EditOperatorForm } from './EditOperatorForm';
import { Notice } from './Notice';
import { OnboardingForm } from './OnboardingForm';
import { PayoutConfirmModal } from './PayoutConfirmModal';
import { PAYOUT_METHOD_SHORT } from './PayoutMethodForm';
import { PayoutVerifyModal } from './PayoutVerifyModal';
import { Pill } from './Pill';
import { TabBar, tabId, tabPanelId } from './TabBar';

/** El API devuelve como mucho estas filas de ganancias y de liquidaciones (sin paginar). */
const HISTORY_LIMIT = 100;

type DetailTab = 'earnings' | 'payouts' | 'edit' | 'onboarding';

interface History {
  earnings: OperatorEarning[];
  payouts: OperatorPayout[];
}

export function OperatorDetailModal({
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
  const [history, setHistory] = useState<History | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('earnings');
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [verifyFor, setVerifyFor] = useState<OperatorPayout | null>(null);
  const generation = useRef(0);
  const tabsId = `np-op-${operator.id.slice(0, 8)}`;
  const payoutMode = payoutModeFor(isOwner, useApprovals().rules?.payout);

  async function loadHistory(): Promise<void> {
    const gen = ++generation.current;
    setHistoryError(null);
    try {
      const [earnings, payouts] = await Promise.all([
        fetchOperatorEarnings(operator.id),
        fetchOperatorPayouts(operator.id),
      ]);
      if (gen === generation.current) setHistory({ earnings, payouts });
    } catch (err) {
      if (gen === generation.current) setHistoryError((err as Error).message);
    }
  }

  useEffect(() => {
    void loadHistory();
    return () => {
      generation.current += 1;
    };
  }, [operator.id]);

  const balance = operator.balance.pendingCents;
  // Lo que un pago liquida hoy (comisiones con más de 7 días, menos deuda por
  // devoluciones). Si el API es antiguo y no lo manda, cae al pendiente total.
  const payable = operator.balance.availableCents ?? balance;
  const needsHelp = operator.needsHelpWallet || operator.needsHelpDocs;
  const tabs: Array<{ key: DetailTab; label: string }> = [
    { key: 'earnings', label: 'Ganancias' },
    { key: 'payouts', label: 'Liquidaciones' },
    { key: 'edit', label: 'Editar' },
    { key: 'onboarding', label: needsHelp ? 'Onboarding · pide ayuda' : 'Onboarding' },
  ];
  // Con un modal encima, Escape cierra solo ese (no este con el de dentro).
  const childOpen = payoutOpen || verifyFor !== null;

  return (
    <Modal
      open
      onClose={childOpen ? () => undefined : onClose}
      title={operator.displayName ?? operator.email}
      width="44rem"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={balanceBox}>
          <span style={balanceLabel}>Saldo pendiente</span>
          <span
            className="np-num"
            style={{
              fontSize: '1.75rem',
              fontWeight: 600,
              marginLeft: 'auto',
              color: balance < 0 ? 'var(--np-danger)' : 'var(--np-success)',
            }}
          >
            {formatEur(balance)}
          </span>
          {payoutMode && payable > 0 ? (
            <Button onClick={() => setPayoutOpen(true)} size="md">
              {payoutMode === 'request' ? 'Pedir pago' : 'Marcar pagado'}
            </Button>
          ) : null}
        </div>

        {operator.balance.availableCents !== undefined ? (
          <p style={{ margin: 0, color: 'var(--np-text-mute)', fontSize: '0.9375rem' }}>
            A pagar ahora <strong className="np-num">{formatEur(Math.max(0, payable))}</strong>
            {operator.balance.heldCents ? (
              <> · en espera (menos de 7 días) {formatEur(operator.balance.heldCents)}</>
            ) : null}
            {operator.balance.debtCents ? (
              <span style={{ color: 'var(--np-danger)' }}>
                {' '}
                · deuda por devoluciones {formatEur(operator.balance.debtCents)}
              </span>
            ) : null}
          </p>
        ) : null}

        <TabBar tabs={tabs} active={tab} onChange={setTab} ariaLabel="Datos de la operadora" idPrefix={tabsId} size="sm" />

        <div role="tabpanel" id={tabPanelId(tabsId, tab)} aria-labelledby={tabId(tabsId, tab)}>
          {tab === 'earnings' || tab === 'payouts' ? (
            historyError ? (
              <Notice tone="danger" action={{ label: 'Reintentar', onClick: () => void loadHistory() }}>
                {historyError}
              </Notice>
            ) : history === null ? (
              <p style={emptyText}>Cargando…</p>
            ) : tab === 'earnings' ? (
              <EarningsTable earnings={history.earnings} />
            ) : (
              <PayoutsTable payouts={history.payouts} canVerify={isOwner} onVerify={setVerifyFor} />
            )
          ) : tab === 'edit' ? (
            <EditOperatorForm
              operator={operator}
              isOwner={isOwner}
              onSaved={() => {
                onChanged();
                onClose();
              }}
            />
          ) : (
            <OnboardingForm operator={operator} onSaved={onChanged} />
          )}
        </div>
      </div>

      {payoutOpen ? (
        <PayoutConfirmModal
          operatorId={operator.id}
          operatorName={operator.displayName ?? operator.email}
          balanceCents={payable}
          payoutMethod={operator.payoutMethod ?? null}
          payoutAddress={operator.payoutAddress ?? null}
          payoutLabel={operator.payoutLabel ?? null}
          mode={payoutMode ?? 'pay'}
          onClose={() => setPayoutOpen(false)}
          onDone={() => {
            setPayoutOpen(false);
            onChanged();
            onClose();
          }}
        />
      ) : null}

      {verifyFor ? (
        <PayoutVerifyModal
          payout={verifyFor}
          operatorMethod={operator.payoutMethod ?? null}
          onClose={() => setVerifyFor(null)}
          onChanged={() => void loadHistory()}
        />
      ) : null}
    </Modal>
  );
}

/**
 * Quién paga a la chica desde aquí: el dueño siempre; el encargado lo pide al
 * dueño si el local lo exige o paga él con 2FA si no. null = no se enseña.
 */
function payoutModeFor(isOwner: boolean, rule: string | undefined): 'pay' | 'pay_2fa' | 'request' | null {
  if (isOwner) return 'pay';
  if (rule === 'request') return 'request';
  if (rule === 'direct_2fa') return 'pay_2fa';
  return null;
}

function EarningsTable({ earnings }: { earnings: OperatorEarning[] }) {
  const tz = useVenueTimezone();
  if (earnings.length === 0) {
    return <p style={emptyText}>Aún no hay ganancias.</p>;
  }
  return (
    <div style={tableWrap}>
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
              <td data-label="Fecha" data-card="top" style={cellMeta}>
                {formatDateTime(e.createdAt, tz, 'datetime')}
              </td>
              <td data-label="Importe" className="np-num" style={numCell}>
                {formatEur(e.paymentAmountCents)}
              </td>
              <td
                data-label="Comisión"
                data-card="amount"
                className="np-num"
                style={{ ...numCell, color: e.netCents < e.commissionCents ? 'var(--np-warning)' : 'var(--np-text)' }}
              >
                {formatEur(e.netCents)} {e.reversedCents > 0 ? `(−${formatEur(e.reversedCents)})` : ''}
              </td>
              <td data-label="Estado" data-card="status" style={cellMeta}>
                {e.payoutId ? 'Liquidada' : 'Pendiente'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <LimitNote count={earnings.length} what="ganancias" />
    </div>
  );
}

function PayoutsTable({
  payouts,
  canVerify,
  onVerify,
}: {
  payouts: OperatorPayout[];
  canVerify: boolean;
  onVerify: (payout: OperatorPayout) => void;
}) {
  const tz = useVenueTimezone();
  if (payouts.length === 0) {
    return <p style={emptyText}>Aún no hay liquidaciones.</p>;
  }
  return (
    <div style={tableWrap}>
      <table className="np-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th style={numCol}>Total</th>
            <th style={numCol}>Comisiones</th>
            <th>Vía</th>
            <th>Verificación</th>
            <th>Referencia</th>
            <th>Pagado por</th>
            {canVerify ? <th aria-label="Acciones" /> : null}
          </tr>
        </thead>
        <tbody>
          {payouts.map((p) => {
            const status = RECONCILIATION_LABELS[p.reconciliationStatus ?? 'UNRECONCILED'];
            const receipt = safeHttpUrl(p.receiptUrl);
            const settled = p.reconciliationStatus === 'MATCHED' || p.reconciliationStatus === 'MANUAL_OK';
            return (
              <tr key={p.id}>
                <td data-label="Fecha" data-card="top" style={cellMeta}>
                  {formatDateTime(p.createdAt, tz, 'datetime')}
                </td>
                <td data-label="Total" data-card="amount" className="np-num" style={numCell}>
                  {formatEur(p.totalCents)}
                </td>
                <td data-label="Comisiones" className="np-num" style={numCell}>
                  {p.earningCount}
                </td>
                <td data-label="Vía" style={cellMeta}>
                  {p.externalRail ? PAYOUT_METHOD_SHORT[p.externalRail] : '—'}
                </td>
                <td data-label="Verificación" data-card="status">
                  <Pill tone={status.tone}>{status.label}</Pill>
                </td>
                <td data-label="Referencia" style={{ ...cellMeta, maxWidth: '12rem' }}>
                  {p.externalTxId ? (
                    <code style={refCode} title={p.externalTxId}>
                      {p.externalTxId}
                    </code>
                  ) : (
                    '—'
                  )}
                  {receipt ? (
                    <>
                      {' '}
                      <a href={receipt} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--np-accent)' }}>
                        recibo
                      </a>
                    </>
                  ) : null}
                </td>
                <td data-label="Pagado por" style={cellMeta}>
                  {p.paidByEmail ?? '—'}
                </td>
                {canVerify ? (
                  <td data-label="Acciones" data-card="actions" style={{ textAlign: 'right' }}>
                    {settled ? null : (
                      <Button variant="ghost" onClick={() => onVerify(p)} style={smallBtn}>
                        Verificar
                      </Button>
                    )}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      <LimitNote count={payouts.length} what="liquidaciones" />
    </div>
  );
}

/** El API no pagina este historial: se avisa si puede haber más de lo que se ve. */
function LimitNote({ count, what }: { count: number; what: string }) {
  if (count < HISTORY_LIMIT) return null;
  return (
    <p style={{ ...emptyText, padding: '0.75rem 0 0', fontSize: '0.8rem' }}>
      Se ven las {HISTORY_LIMIT} {what} más recientes.
    </p>
  );
}

const balanceBox: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.75rem',
  padding: '1rem',
  background: 'var(--np-surface)',
  borderRadius: 'var(--np-r-md)',
  flexWrap: 'wrap',
};

const balanceLabel: CSSProperties = {
  fontSize: '0.7rem',
  color: 'var(--np-text-dim)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
};

const tableWrap: CSSProperties = { maxHeight: '24rem', overflow: 'auto' };
const numCol: CSSProperties = { textAlign: 'right' };
const numCell: CSSProperties = { textAlign: 'right', fontWeight: 500 };
const cellMeta: CSSProperties = { color: 'var(--np-text-mute)' };
const smallBtn: CSSProperties = { height: '2.25rem', padding: '0 0.875rem', fontSize: '0.8125rem' };
const refCode: CSSProperties = {
  fontFamily: 'var(--np-font-mono)',
  fontSize: '0.72rem',
  display: 'inline-block',
  maxWidth: '9rem',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  verticalAlign: 'bottom',
};
const emptyText: CSSProperties = {
  textAlign: 'center',
  color: 'var(--np-text-dim)',
  padding: '2rem 1rem',
  margin: 0,
};
