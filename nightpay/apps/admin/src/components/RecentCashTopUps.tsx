'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button, Card, Input, Modal } from '@nightpay/ui';
import { fetchRecentCashTopUps, voidCashTopUp, type RecentCashTopUp } from '@/lib/api';
import { ApiError, totpRetryState } from '@/lib/api-errors';
import { cashVoidBody, cashVoidDoneText, cashVoidOutText, cashVoidProblem } from '@/lib/cash-void';
import { formatDateTime } from '@/lib/dates';
import { formatEur } from '@/lib/money';
import { useLockActive } from '@/lib/use-lock';
import { useVenueTimezone } from '@/lib/venue-context';
import { OtpInput } from './OtpInput';

/**
 * Recargas en efectivo de las 2 últimas horas (recepción): el encargado o el
 * dueño anula una mal tecleada, siempre con su 2FA y si el saldo aún la cubre.
 * Sin permiso (403) no sale nada.
 */
export function RecentCashTopUps() {
  const tz = useVenueTimezone();
  const [rows, setRows] = useState<RecentCashTopUp[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<RecentCashTopUp | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      setRows(await fetchRecentCashTopUps());
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setHidden(true);
      else setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (hidden || (rows !== null && rows.length === 0 && !notice && !error)) return null;

  return (
    <Card style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div style={headerStyle}>
        <h3 style={titleStyle}>Recargas en efectivo (últimas 2 h)</h3>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          Actualizar
        </Button>
      </div>
      {notice ? (
        <p role="status" style={{ margin: 0, color: 'var(--np-success)', fontWeight: 600 }}>
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" style={{ margin: 0, color: 'var(--np-danger)' }}>
          {error}
        </p>
      ) : null}
      {rows === null ? <p style={mutedStyle}>Cargando…</p> : null}
      <ul style={listStyle}>
        {(rows ?? []).map((r) => (
          <li key={r.id} style={rowStyle}>
            <span className="np-num" style={{ fontWeight: 700 }}>
              {formatEur(r.amountCents)}
            </span>
            {r.serviceFeeCents ? (
              <span style={mutedStyle} className="np-num">
                + {formatEur(r.serviceFeeCents)} de comisión del servicio
              </span>
            ) : null}
            <span style={mutedStyle}>
              {r.codeHint} · {formatDateTime(r.at, tz)}
            </span>
            {r.voided ? (
              <span style={mutedStyle}>Anulada</span>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setVoiding(r)}>
                Anular
              </Button>
            )}
          </li>
        ))}
      </ul>
      {voiding ? (
        <VoidModal
          topUp={voiding}
          onClose={() => setVoiding(null)}
          onDone={(text) => {
            setVoiding(null);
            setNotice(text);
            void load();
          }}
        />
      ) : null}
    </Card>
  );
}

function VoidModal({
  topUp,
  onClose,
  onDone,
}: {
  topUp: RecentCashTopUp;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const locked = useLockActive(lockedUntil);

  async function submit(): Promise<void> {
    if (submitting) return;
    const problem = cashVoidProblem(reason, code);
    if (problem) return setError(problem);
    setSubmitting(true);
    setError(null);
    try {
      onDone(cashVoidDoneText(await voidCashTopUp(topUp.id, cashVoidBody(topUp, reason, code))));
    } catch (err) {
      const retry = totpRetryState(err, Date.now());
      if (retry.lockedUntil !== null) setLockedUntil(retry.lockedUntil);
      setCode('');
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={submitting ? () => undefined : onClose} title="Anular recarga en efectivo">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}
      >
        <p style={{ margin: 0 }}>
          Recarga de <strong className="np-num">{formatEur(topUp.amountCents)}</strong> al saldo {topUp.codeHint}. Al
          anularla, salen de la caja <strong className="np-num">{cashVoidOutText(topUp)}</strong> y el saldo baja{' '}
          {formatEur(topUp.amountCents)} (solo si aún lo tiene).
        </p>
        <Input
          label="Por qué se anula"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={200}
          placeholder="ej: tecleé 500 en vez de 50"
        />
        <OtpInput
          label="Código de tu app de verificación (2FA)"
          value={code}
          onChange={setCode}
          lockedUntil={lockedUntil}
          autoSubmit={reason.trim().length >= 3}
          required
          hint="Anular una recarga en efectivo pide siempre los 6 números de tu app de verificación."
        />
        {error ? (
          <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
            {error}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <Button variant="ghost" type="button" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button type="submit" loading={submitting} disabled={locked}>
            Anular {formatEur(topUp.amountCents + (topUp.serviceFeeCents ?? 0))}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const headerStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' };
const titleStyle: CSSProperties = { margin: 0, fontSize: '1rem', fontWeight: 600 };
const mutedStyle: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '0.875rem' };
const listStyle: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' };
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  flexWrap: 'wrap',
  padding: '0.5rem 0',
  borderBottom: '1px solid var(--np-border)',
};
