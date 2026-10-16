'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Card } from '@nightpay/ui';
import {
  fetchMyEarnings,
  fetchMyPayoutInfo,
  fetchMyPayouts,
  type MyEarning,
  type MyNight,
  type MyPayout,
  type MyPayoutInfo,
  type OperatorBalance,
} from '@/lib/api';
import {
  dayLabel,
  groupByNight,
  heldItems,
  heldUntil,
  moneySummary,
  otherNightsUnpaid,
  type MoneySummary,
} from '@/lib/earnings-view';
import { formatEur, formatSignedEur } from '@/lib/money';
import { EarningsDetail, type DetailKind } from './EarningsDetail';
import { PayoutsReceived } from './PayoutsReceived';
import { Chevron, TonightCard } from './TonightCard';
import styles from './money.module.css';

interface Props {
  /** La noche y el saldo los trae el Dashboard (se refrescan solos). */
  night: MyNight | null;
  balance: OperatorBalance | null;
  /** No se pudo cargar la noche (el fallo del saldo ya sale arriba). */
  nightError: string | null;
}

/**
 * Ganancias de la chica: ¿cuánto y cuándo? Arriba lo de esta noche (se le
 * paga al cerrar); debajo lo de otras noches, lo que está en espera y lo que
 * se le descuenta, cada cosa con su detalle; al final, lo que ya le pagaron.
 */
export function Earnings({ night, balance, nightError }: Props) {
  const [detail, setDetail] = useState<DetailKind | null>(null);
  const [earnings, setEarnings] = useState<MyEarning[] | null>(null);
  const [payouts, setPayouts] = useState<MyPayout[] | null>(null);
  // undefined: cargando; null: no se pudo (API antiguo o caído).
  const [info, setInfo] = useState<MyPayoutInfo | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  // Las listas se recargan cuando cambia el saldo (cobro nuevo, pago, devolución).
  const reloadKey = balance ? `${balance.count}:${balance.pendingCents}:${balance.paidCents}:${balance.debtCents}` : '';
  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([fetchMyEarnings(), fetchMyPayouts(), fetchMyPayoutInfo()]).then(([e, p, i]) => {
      if (cancelled) return;
      // Si falla, se queda lo que había (o vacío): nada de «Cargando…» para siempre.
      setEarnings((prev) => (e.status === 'fulfilled' ? e.value : (prev ?? [])));
      setPayouts((prev) => (p.status === 'fulfilled' ? p.value : (prev ?? [])));
      setInfo((prev) => (i.status === 'fulfilled' ? i.value : (prev ?? null)));
      const failed = e.status === 'rejected' ? e : p.status === 'rejected' ? p : null;
      setError(failed ? errorText(failed.reason) : null);
    });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // Al entrar o salir de un detalle, desde arriba.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [detail]);

  const summary = moneySummary(night, balance);
  const holdDays = info ? info.holdDays : null;

  if (detail) {
    return (
      <EarningsDetail
        kind={detail}
        night={night}
        summary={summary}
        earnings={earnings}
        info={info ?? null}
        holdDays={holdDays}
        onBack={() => setDetail(null)}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {nightError ? <ErrorCard text={nightError} /> : null}
      {error ? <ErrorCard text={error} /> : null}
      <TonightCard night={night} summary={summary} holdDays={holdDays} onOpen={() => setDetail('tonight')} />
      <MoneyRows summary={summary} holdDays={holdDays} earnings={earnings} night={night} onOpen={setDetail} />
      <NextPayout summary={summary} />
      <PayoutsReceived payouts={payouts} account={info ? info.account : undefined} />
    </div>
  );
}

interface RowsProps {
  summary: MoneySummary;
  holdDays: number | null;
  earnings: MyEarning[] | null;
  night: MyNight | null;
  onOpen: (kind: DetailKind) => void;
}

function MoneyRows({ summary, holdDays, earnings, night, onOpen }: RowsProps) {
  const nights = earnings ? groupByNight(otherNightsUnpaid(earnings, night)).length : 0;
  const until = holdDays ? heldUntil(heldItems(earnings ?? [], holdDays, Date.now())) : null;
  // «En espera» solo si el local espera días antes de pagar (con pago cada noche, no sale).
  const showHeld = (holdDays ?? 0) > 0 || summary.heldCents > 0;
  const other = summary.otherNightsCents;
  const debt = summary.debtCents;

  return (
    <nav aria-label="Lo demás que te deben" className={styles.rows}>
      <Row
        label="Pendiente de otras noches"
        sub={other > 0 ? (nights > 0 ? `${nights} ${nights === 1 ? 'noche' : 'noches'} sin cobrar` : 'Ganado y aún sin cobrar') : 'Nada pendiente'}
        amount={formatEur(other, { compact: true })}
        color={other > 0 ? 'var(--np-text)' : 'var(--np-text-mute)'}
        onClick={() => onOpen('other')}
      />
      {showHeld ? (
        <Row
          label="En espera"
          sub={until ? `Hasta el ${dayLabel(until)}, por si hay devoluciones` : 'Por si hay devoluciones'}
          amount={formatEur(summary.heldCents, { compact: true })}
          color={summary.heldCents > 0 ? 'var(--np-warning)' : 'var(--np-text-mute)'}
          onClick={() => onOpen('held')}
        />
      ) : null}
      <Row
        label="Deudas y descuentos"
        sub={debt > 0 ? 'Se descuenta del próximo pago' : 'Nada que descontar'}
        amount={debt > 0 ? formatSignedEur(-debt, { compact: true }) : formatEur(0, { compact: true })}
        color={debt > 0 ? 'var(--np-danger)' : 'var(--np-text-mute)'}
        onClick={() => onOpen('debts')}
      />
    </nav>
  );
}

function Row({ label, sub, amount, color, onClick }: { label: string; sub: string; amount: string; color: string; onClick: () => void }) {
  return (
    <button type="button" className={styles.row} onClick={onClick}>
      <span style={{ display: 'flex', flexDirection: 'column', gap: '0.125rem', minWidth: 0 }}>
        <span style={{ fontSize: '1rem', fontWeight: 700, lineHeight: 1.3 }}>{label}</span>
        <span style={{ fontSize: '0.875rem', color: 'var(--np-text-mute)', lineHeight: 1.35 }}>{sub}</span>
      </span>
      <span className="np-num" style={{ fontSize: '1.125rem', fontWeight: 700, color, whiteSpace: 'nowrap' }}>
        {amount}
      </span>
      <Chevron />
    </button>
  );
}

/** Lo que entra en el próximo pago, si no es solo lo de esta noche. */
function NextPayout({ summary }: { summary: MoneySummary }) {
  const { nextPayoutCents, otherNightsCents, debtCents, heldCents, tonightUnpaidCents, owedAfterCents } = summary;
  if (nextPayoutCents === null || (otherNightsCents <= 0 && debtCents <= 0 && heldCents <= 0)) return null;
  const sources = [tonightUnpaidCents > 0 ? 'esta noche' : null, otherNightsCents > 0 ? 'otras noches' : null].filter(Boolean);
  const explain = [
    sources.length > 0 ? sources.join(' + ') : null,
    debtCents > 0 ? '− deudas' : null,
    heldCents > 0 ? '(sin lo que está en espera)' : null,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div style={nextStyle}>
      <div style={{ minWidth: 0 }}>
        <p style={nextLabel}>Próximo pago</p>
        <p style={nextExplain}>
          {explain ? capitalize(explain) : null}
          {owedAfterCents > 0 ? (
            <>
              {explain ? '. ' : null}Debes <strong className="np-num">{formatEur(owedAfterCents, { compact: true })}</strong>: se
              descuenta de lo que ganes después.
            </>
          ) : null}
        </p>
      </div>
      <span className="np-num" style={nextAmount}>
        {formatEur(nextPayoutCents, { compact: true })}
      </span>
    </div>
  );
}

function ErrorCard({ text }: { text: string }) {
  return (
    <Card role="alert" style={{ padding: '0.875rem', borderColor: 'var(--np-danger)' }}>
      <p style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.9375rem' }}>{text}</p>
    </Card>
  );
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'No se pudieron cargar tus ganancias.';
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const nextStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  padding: '0.875rem 1.125rem',
  background: 'var(--np-surface-2)',
  borderLeft: '4px solid var(--np-accent)',
  borderRadius: 'var(--np-r-md)',
};

const nextLabel: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-label)',
  color: 'var(--np-text-label)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 700,
};

const nextExplain: CSSProperties = {
  margin: '0.25rem 0 0',
  fontSize: '0.875rem',
  color: 'var(--np-text-mute)',
  lineHeight: 1.4,
};

const nextAmount: CSSProperties = {
  fontSize: '1.5rem',
  fontWeight: 700,
  color: 'var(--np-accent)',
  whiteSpace: 'nowrap',
};
