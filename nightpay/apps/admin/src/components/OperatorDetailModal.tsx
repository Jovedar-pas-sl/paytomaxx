'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button, StaffAvatar } from '@nightpay/ui';
import type { StaffFicha } from '@nightpay/contracts';
import {
  fetchOperatorEarnings,
  fetchOperatorPayouts,
  fetchStaffFicha,
  removeStaffPhoto,
  type Operator,
  type OperatorEarning,
  type OperatorPayout,
} from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { payButtonLabel, staffSheet } from '@/lib/ficha-sheets';
import { formatEur } from '@/lib/money';
import { eurShort, railNote } from '@/lib/money-map-view';
import { RECONCILIATION_LABELS } from '@/lib/payout-verify';
import { safeHttpUrl } from '@/lib/urls';
import { useApprovals } from '@/lib/use-approvals';
import { useSections } from '@/lib/use-sections';
import { useVenueTimezone } from '@/lib/venue-context';
import { BankHoldsSection } from './BankHoldsSection';
import { EditOperatorForm } from './EditOperatorForm';
import { FichaSheet, SheetChip } from './fichas/FichaSheet';
import { FichaTimeline } from './fichas/FichaTimeline';
import { OperatorCobros } from './fichas/OperatorCobros';
import { Notice } from './Notice';
import { OnboardingForm } from './OnboardingForm';
import { PayoutConfirmModal } from './PayoutConfirmModal';
import { PAYOUT_METHOD_SHORT } from './PayoutMethodForm';
import { PayoutVerifyModal } from './PayoutVerifyModal';
import { Pill } from './Pill';

/** El API devuelve como mucho estas filas de ganancias y de liquidaciones (sin paginar). */
const HISTORY_LIMIT = 100;

/** La ficha (maqueta 9.2) y, desde ella, lo demás de la chica. */
type View = 'main' | 'cobros' | 'earnings' | 'payouts' | 'edit' | 'onboarding';

const VIEW_LABEL: Readonly<Record<Exclude<View, 'main'>, string>> = {
  cobros: 'Todos sus cobros',
  earnings: 'Ganancias',
  payouts: 'Pagos hechos',
  edit: 'Editar',
  onboarding: 'Onboarding',
};

interface History {
  earnings: OperatorEarning[];
  payouts: OperatorPayout[];
}

/**
 * Ficha de la chica (maqueta 9.2), y la del camarero con su parte de las
 * invitaciones: lo vendido, lo suyo y lo pagado esta noche, lo que le toca de
 * cada cosa, cada cobro con su referencia, sección, cómo pagó y su parte, y
 * un solo botón para pagarle lo que se le debe (mismo pago, aprobaciones y
 * 2FA para los dos). Desde ella: todos sus cobros, ganancias, pagos y, de la
 * chica, editar y onboarding.
 */
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
  const tz = useVenueTimezone();
  const { sections } = useSections();
  const [ficha, setFicha] = useState<StaffFicha | null>(null);
  const [fichaError, setFichaError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<View>('main');
  const [history, setHistory] = useState<History | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [verifyFor, setVerifyFor] = useState<OperatorPayout | null>(null);
  const generation = useRef(0);
  const [photoGone, setPhotoGone] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const payoutMode = payoutModeFor(isOwner, useApprovals().rules?.payout);

  useEffect(() => {
    let cancelled = false;
    setFichaError(null);
    fetchStaffFicha(operator.id)
      .then((f) => {
        if (!cancelled) setFicha(f);
      })
      .catch((err: Error) => {
        if (!cancelled) setFichaError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [operator.id, attempt]);

  async function loadHistory(): Promise<void> {
    const gen = ++generation.current;
    setHistoryError(null);
    try {
      const [earnings, payouts] = await Promise.all([fetchOperatorEarnings(operator.id), fetchOperatorPayouts(operator.id)]);
      if (gen === generation.current) setHistory({ earnings, payouts });
    } catch (err) {
      if (gen === generation.current) setHistoryError((err as Error).message);
    }
  }

  useEffect(() => {
    if ((view === 'earnings' || view === 'payouts') && history === null) void loadHistory();
  }, [view]);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const name = operator.displayName ?? operator.email;
  const photoHash = photoGone ? null : (operator.photoHash ?? null);

  /** Quitar la foto de esta persona (por si sube algo que no toca): queda en el registro. */
  async function dropPhoto(): Promise<void> {
    if (photoBusy) return;
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      await removeStaffPhoto(operator.id);
      setPhotoGone(true);
      onChanged();
    } catch (err) {
      setPhotoError((err as Error).message);
    } finally {
      setPhotoBusy(false);
    }
  }
  const sheet = ficha ? staffSheet(ficha, sections, tz) : null;
  const camarero = ficha?.person.role === 'WAITER';
  // Lo que un pago liquida hoy (pasados los días de espera, menos deuda). Si
  // el API es antiguo y no lo manda, cae al pendiente total.
  const payable = operator.balance.availableCents ?? operator.balance.pendingCents;
  const needsHelp = operator.needsHelpWallet || operator.needsHelpDocs;
  const covered = payoutOpen || verifyFor !== null;
  const more: Array<Exclude<View, 'main'>> = camarero
    ? ['cobros', 'earnings', 'payouts']
    : ['cobros', 'earnings', 'payouts', 'edit', 'onboarding'];

  const footer =
    view !== 'main' ? null : (
      <>
        <BalanceNote operator={operator} payable={payable} />
        {payoutMode && payable > 0 ? (
          <Button size="lg" onClick={() => setPayoutOpen(true)}>
            {payButtonLabel(payoutMode, payable, name)}
          </Button>
        ) : null}
      </>
    );

  return (
    <FichaSheet
      title={sheet?.title ?? name}
      subtitle={view === 'main' ? (sheet?.subtitle ?? 'Cargando…') : VIEW_LABEL[view]}
      chip={sheet ? <SheetChip color={sheet.chip.color}>{sheet.chip.label}</SheetChip> : undefined}
      stripe={sheet ? [{ key: 'chip', label: sheet.chip.label, cents: 1, color: sheet.chip.color }] : undefined}
      onBack={view === 'main' ? onClose : () => setView('main')}
      backLabel={view === 'main' ? 'Cerrar la ficha' : 'Volver a la ficha'}
      covered={covered}
      footer={footer}
      overlays={
        <>
          {payoutOpen ? (
            <PayoutConfirmModal
              operatorId={operator.id}
              operatorName={name}
              balanceCents={payable}
              bankHeld={{ bankHeldCents: operator.balance.bankHeldCents, bankHeldCount: operator.balance.bankHeldCount }}
              payoutMethod={operator.payoutMethod ?? null}
              payoutAddressMasked={operator.payoutAddressMasked ?? null}
              payoutHolderMasked={operator.payoutHolderMasked ?? null}
              // Con nombre legal, el aviso es el de confirmar (o ya confirmada: nada).
              payoutHolderMismatch={(operator.payoutHolderMismatch ?? false) && !operator.legalNameMasked}
              payoutHolderUnconfirmed={operator.payoutHolderUnconfirmed ?? false}
              payoutHoldUntil={operator.payoutHoldUntil ?? null}
              canReveal={isOwner}
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
        </>
      }
    >
      {view === 'main' ? (
        <>
          <div className="np-ficha-person" style={personRow}>
            <StaffAvatar userId={operator.id} hash={photoHash} name={operator.displayName?.trim() || null} size={56} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.125rem', minWidth: 0, flex: 1 }}>
              <b style={{ overflowWrap: 'anywhere' }}>{name}</b>
              {operator.phone ? <span style={{ color: 'var(--np-text-mute)', fontSize: 'var(--np-fs-14)' }}>{operator.phone}</span> : null}
            </div>
            {photoHash ? (
              <Button variant="ghost" size="sm" loading={photoBusy} onClick={() => void dropPhoto()}>
                Quitar foto
              </Button>
            ) : null}
          </div>
          {photoError ? <Notice tone="danger">{photoError}</Notice> : null}
          {fichaError ? (
            <Notice tone="danger" action={{ label: 'Reintentar', onClick: () => setAttempt((n) => n + 1) }}>
              {fichaError}
            </Notice>
          ) : null}
          {!sheet ? (
            fichaError ? null : <p className="np-ficha-empty">Cargando…</p>
          ) : (
            <>
              <div className="np-ficha-stats">
                {sheet.stats.map((s) => (
                  <div key={s.key} className="np-ficha-stat">
                    <span>{s.label}</span>
                    <b>{eurShort(s.cents)}</b>
                  </div>
                ))}
              </div>
              {sheet.rates.length > 0 ? (
                <ul className="np-ficha-rates" aria-label="Lo que le toca de cada cosa">
                  {sheet.rates.map((r) => (
                    <li key={r.key} style={{ '--np-c': r.color } as CSSProperties}>
                      {r.label} <b>{r.value}</b>
                    </li>
                  ))}
                </ul>
              ) : null}
              {/* Ventas por datáfono sin cuadrar con el banco: su parte, retenida (H-1). */}
              <BankHoldsSection operatorId={operator.id} name={name} balance={operator.balance} onReleased={onChanged} />
              <FichaTimeline
                rows={sheet.rows}
                empty={camarero ? 'Esta noche aún no le toca nada de las invitaciones.' : 'Esta noche aún no ha cobrado nada.'}
                label="Sus cobros de esta noche"
              />
              {sheet.payline ? (
                <p className="np-ficha-payline">
                  <span>
                    Pagos <em>· {sheet.payline.text}</em>
                  </span>
                  <b>{railNote(sheet.payline.rail)}</b>
                </p>
              ) : null}
            </>
          )}
          <nav className="np-ficha-more" aria-label={`Más de ${name}`}>
            {more.map((v) => (
              <Button key={v} variant="ghost" size="sm" onClick={() => setView(v)}>
                {v === 'onboarding' && needsHelp ? 'Onboarding · pide ayuda' : VIEW_LABEL[v]}
              </Button>
            ))}
          </nav>
        </>
      ) : view === 'cobros' ? (
        <OperatorCobros operatorId={operator.id} />
      ) : view === 'earnings' || view === 'payouts' ? (
        historyError ? (
          <Notice tone="danger" action={{ label: 'Reintentar', onClick: () => void loadHistory() }}>
            {historyError}
          </Notice>
        ) : history === null ? (
          <p className="np-ficha-empty">Cargando…</p>
        ) : view === 'earnings' ? (
          <EarningsTable earnings={history.earnings} />
        ) : (
          <PayoutsTable payouts={history.payouts} canVerify={isOwner} onVerify={setVerifyFor} />
        )
      ) : view === 'edit' ? (
        <EditOperatorForm
          operator={operator}
          isOwner={isOwner}
          onSaved={() => {
            onChanged();
            onClose();
          }}
        />
      ) : (
        <OnboardingForm operator={operator} isOwner={isOwner} onSaved={onChanged} />
      )}
    </FichaSheet>
  );
}

/** Lo que se le debe (y lo que espera o descuenta), encima del botón de pagar. */
function BalanceNote({ operator, payable }: { operator: Operator; payable: number }) {
  const b = operator.balance;
  const parts: string[] = [];
  if (b.availableCents === undefined) parts.push(`Se le debe ${formatEur(b.pendingCents)}`);
  else if (payable <= 0) parts.push('Nada que pagarle ahora');
  if (b.heldCents) parts.push(`en espera (días del local) ${formatEur(b.heldCents)}`);
  if (b.bankHeldCents) parts.push(`pendiente de cuadrar con el banco ${formatEur(b.bankHeldCents)}`);
  if (b.debtCents) parts.push(`deuda por devoluciones ${formatEur(b.debtCents)}`);
  if (parts.length === 0) return null;
  return <p className="np-mm-note">{parts.join(' · ')}</p>;
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
                      <a href={receipt} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--np-text)', textDecoration: 'underline' }}>
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
                      <Button variant="ghost" onClick={() => onVerify(p)} size="sm">
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
    <p style={{ ...emptyText, padding: '0.75rem 0 0', fontSize: '0.875rem' }}>
      Se ven las {HISTORY_LIMIT} {what} más recientes.
    </p>
  );
}

const tableWrap: CSSProperties = { maxHeight: '24rem', overflow: 'auto' };
const numCol: CSSProperties = { textAlign: 'right' };
const numCell: CSSProperties = { textAlign: 'right', fontWeight: 400 };
const cellMeta: CSSProperties = { color: 'var(--np-text-mute)' };
const refCode: CSSProperties = {
  fontFamily: 'var(--np-font-mono)',
  fontSize: '0.875rem',
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

const personRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 };
