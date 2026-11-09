'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Input, Modal } from '@nightpay/ui';
import { fetchRefunds, resolvePendingRefund, type PaymentRow, type Refund } from '@/lib/api';
import { ApiError } from '@/lib/api-errors';
import { formatDateTime } from '@/lib/dates';
import { formatEur, formatMoney } from '@/lib/money';
import { refundServiceFeeHint } from '@/lib/service-fee-text';
import { useVenueTimezone } from '@/lib/venue-context';
import { Notice } from './Notice';
import { Pill, type Tone } from './Pill';

/** Antes de esto la pasarela aún puede contestar (el API tampoco deja resolverla). */
const RESOLVE_AFTER_MS = 2 * 60 * 1000;

const STATUS: Record<Refund['status'], { label: string; tone: Tone }> = {
  PENDING: { label: 'Sin confirmar', tone: 'warning' },
  SUCCEEDED: { label: 'Hecha', tone: 'success' },
  FAILED: { label: 'No hecha', tone: 'danger' },
};

/**
 * Devoluciones de un cobro. Una que quedó sin confirmar por la pasarela
 * (PENDING, reservada para que no se repita) la resuelve el dueño tras mirarla
 * en el portal: hecha (se descuenta) o no hecha (se libera).
 */
export function RefundsModal({
  payment,
  isOwner,
  onClose,
  onChanged,
}: {
  payment: PaymentRow;
  isOwner: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const tz = useVenueTimezone();
  const [refunds, setRefunds] = useState<Refund[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<Refund | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    fetchRefunds(payment.id)
      .then((list) => {
        if (!cancelled) setRefunds(list);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [payment.id, attempt]);

  return (
    <Modal open onClose={onClose} title="Devoluciones del cobro" width="36rem">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <p style={metaStyle}>
          Cobro de <strong className="np-num">{formatMoney(payment.amountCents, payment.currency)}</strong> ·{' '}
          {formatDateTime(payment.createdAt, tz, 'short')} · queda por devolver{' '}
          {formatMoney(payment.availableAmountCents, payment.currency)}
        </p>
        {refundServiceFeeHint(payment) ? <p style={metaStyle}>{refundServiceFeeHint(payment)}</p> : null}
        {loadError ? (
          <Notice tone="danger" action={{ label: 'Reintentar', onClick: () => setAttempt((n) => n + 1) }}>
            {loadError}
          </Notice>
        ) : refunds === null ? (
          <p style={metaStyle}>Cargando…</p>
        ) : refunds.length === 0 ? (
          <p style={metaStyle}>Este cobro no tiene devoluciones.</p>
        ) : (
          <ul style={listStyle}>
            {refunds.map((r) => (
              <li key={r.id} style={itemStyle}>
                <div style={rowStyle}>
                  <strong className="np-num">{formatEur(r.amountCents)}</strong>
                  <Pill tone={STATUS[r.status]?.tone ?? 'neutral'}>{STATUS[r.status]?.label ?? r.status}</Pill>
                  <span style={metaStyle}>{formatDateTime(r.createdAt, tz, 'short')}</span>
                </div>
                {r.reason ? <p style={metaStyle}>{r.reason}</p> : null}
                {r.status === 'PENDING' ? <PendingHint refund={r} isOwner={isOwner} onResolve={() => setResolving(r)} /> : null}
              </li>
            ))}
          </ul>
        )}
        {resolving ? (
          <ResolveRefundForm
            payment={payment}
            refund={resolving}
            onCancel={() => setResolving(null)}
            onResolved={() => {
              setResolving(null);
              setAttempt((n) => n + 1);
              onChanged();
            }}
          />
        ) : null}
        <Button variant="ghost" onClick={onClose}>
          Cerrar
        </Button>
      </div>
    </Modal>
  );
}

function PendingHint({ refund, isOwner, onResolve }: { refund: Refund; isOwner: boolean; onResolve: () => void }) {
  const waitMs = RESOLVE_AFTER_MS - (Date.now() - Date.parse(refund.createdAt));
  if (!isOwner) return <p style={metaStyle}>La pasarela no la confirmó: la resuelve el dueño.</p>;
  if (waitMs > 0) {
    return <p style={metaStyle}>La pasarela aún puede contestar: espera un par de minutos y vuelve a abrir esto.</p>;
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
      <span style={metaStyle}>La pasarela no la confirmó. Mírala en su portal y resuélvela.</span>
      <Button variant="ghost" onClick={onResolve} size="sm">
        Resolver
      </Button>
    </div>
  );
}

function ResolveRefundForm({
  payment,
  refund,
  onCancel,
  onResolved,
}: {
  payment: PaymentRow;
  refund: Refund;
  onCancel: () => void;
  onResolved: () => void;
}) {
  const [outcome, setOutcome] = useState<'SUCCEEDED' | 'FAILED' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!outcome) return setError('Elige si la pasarela la hizo o no.');
    if (note.trim().length < 3) return setError('Explica qué viste en el portal de la pasarela.');
    setBusy(true);
    try {
      await resolvePendingRefund(payment.id, refund.id, { outcome, note: note.trim() });
      onResolved();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? 'El servidor todavía no permite resolverla desde aquí.'
          : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={formBox}>
      <p style={{ margin: 0, fontWeight: 600 }}>Resolver la devolución de {formatEur(refund.amountCents)}</p>
      <div role="radiogroup" aria-label="¿La hizo la pasarela?" style={choiceRow}>
        <Button
          type="button"
          variant={outcome === 'SUCCEEDED' ? 'primary' : 'ghost'}
          aria-pressed={outcome === 'SUCCEEDED'}
          onClick={() => setOutcome('SUCCEEDED')}
        >
          Sí, está hecha
        </Button>
        <Button
          type="button"
          variant={outcome === 'FAILED' ? 'primary' : 'ghost'}
          aria-pressed={outcome === 'FAILED'}
          onClick={() => setOutcome('FAILED')}
        >
          No se hizo
        </Button>
      </div>
      <p style={metaStyle}>
        {outcome === 'SUCCEEDED'
          ? 'Se descuenta del cobro y de la parte de la chica.'
          : outcome === 'FAILED'
            ? 'Se libera lo reservado: se podrá devolver otra vez.'
            : ''}
      </p>
      <Input
        label="Qué viste en el portal"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
        placeholder="ej: aparece devuelta en el portal BBVA a las 22:10"
        required
      />
      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
          {error}
        </p>
      ) : null}
      <div style={choiceRow}>
        <Button type="submit" loading={busy}>
          Guardar
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

const metaStyle: CSSProperties = { margin: 0, fontSize: '0.8125rem', color: 'var(--np-text-mute)' };
const listStyle: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' };
const itemStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.35rem',
  padding: '0.75rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
};
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' };
const formBox: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  padding: '0.875rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  background: 'var(--np-surface)',
};
const choiceRow: CSSProperties = { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' };
