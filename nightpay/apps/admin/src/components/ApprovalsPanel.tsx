'use client';

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Button, Input, useNow } from '@nightpay/ui';
import type { PayoutMethod } from '@nightpay/contracts';
import { approveApproval, fetchApprovals, rejectApproval, type ApprovalView } from '@/lib/api';
import { ApiError, totpLockedUntil } from '@/lib/api-errors';
import {
  APPROVAL_STATUS,
  approvalReason,
  approvalTarget,
  approveSummary,
  approvedMessage,
  decisionLine,
  expiresIn,
  kindLabel,
  rejectNoteProblem,
  timeAgo,
} from '@/lib/approvals';
import { formatEur } from '@/lib/money';
import { useApprovals } from '@/lib/use-approvals';
import { useLockActive } from '@/lib/use-lock';
import { useVenue } from '@/lib/venue-context';
import { ConfirmLine } from './ConfirmLine';
import { Notice } from './Notice';
import { OtpInput } from './OtpInput';
import { settle } from './PayoutConfirmModal';
import { PAYOUT_METHOD_SHORT } from './PayoutMethodForm';
import { Pill, type Tone } from './Pill';

const methodLabel = (m: PayoutMethod) => PAYOUT_METHOD_SHORT[m] ?? m;
/** Lo decidido que se enseña debajo. */
const RECENT_LIMIT = 10;
/** Ya no se puede decidir (otra persona, caducada, no se pudo hacer): se cuenta arriba y se refresca. */
const FINAL_CODES = new Set(['APPROVAL_FAILED', 'APPROVAL_NOT_PENDING', 'APPROVAL_EXPIRED', 'REFUND_OUTCOME_UNKNOWN']);

interface Outcome {
  tone: Tone;
  text: string;
}

/**
 * «Por aprobar» (dueño): lo que pide el encargado, una tarjeta por solicitud.
 * Aprobar = la frase de confirmación + el código 2FA (al poner el sexto
 * número se aprueba); rechazar pide el motivo, que verá el encargado.
 */
export function ApprovalsPanel() {
  const feed = useApprovals();
  const { refresh } = feed;
  const [recent, setRecent] = useState<ApprovalView[] | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const pendingId = useId();
  const recentId = useId();
  const now = new Date(useNow(true, 30_000));

  const loadRecent = useCallback(async () => {
    try {
      const items = await fetchApprovals(undefined, 30);
      setRecent(items.filter((i) => i.status !== 'PENDING').slice(0, RECENT_LIMIT));
    } catch {
      // Lo decidido es solo para mirar: si falla, se queda lo de antes.
    }
  }, []);

  // Al abrir la pestaña, lo último (la barra refresca cada 20 s).
  useEffect(() => {
    refresh();
    void loadRecent();
  }, [refresh, loadRecent]);

  function done(result: Outcome): void {
    setOutcome(result);
    refresh();
    void loadRecent();
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div>
        <h2 className="np-approvals-title">Por aprobar</h2>
        <p className="np-approvals-hint">
          Lo que pide el encargado: pagos a las chicas y devoluciones grandes. Se aprueba con tu código 2FA; quien lo
          pide no puede aprobarlo. Sin decidir, caduca a las 24 h.
        </p>
      </div>

      {outcome ? (
        <Notice tone={outcome.tone} action={{ label: 'Entendido', onClick: () => setOutcome(null) }}>
          {outcome.text}
        </Notice>
      ) : null}
      {feed.error ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: refresh }}>
          No se pudieron cargar las solicitudes: {feed.error}
        </Notice>
      ) : null}

      <section aria-labelledby={pendingId} style={groupStyle}>
        <h3 id={pendingId} className="np-inbox-head">
          Pendientes <span className="np-inbox-count">{feed.pending ? feed.pending.length : '…'}</span>
        </h3>
        {feed.pending === null ? (
          feed.error ? null : <p className="np-approvals-hint">Cargando…</p>
        ) : feed.pending.length === 0 ? (
          <p className="np-inbox-empty">Nada por aprobar.</p>
        ) : (
          <ul className="np-approvals">
            {feed.pending.map((item) => (
              <ApprovalCard key={item.id} item={item} now={now} onDone={done} />
            ))}
          </ul>
        )}
      </section>

      {recent && recent.length > 0 ? (
        <section aria-labelledby={recentId} style={groupStyle}>
          <h3 id={recentId} className="np-inbox-head">
            Decididas hace poco
          </h3>
          <ul className="np-approvals">
            {recent.map((item) => (
              <DecidedRow key={item.id} item={item} now={now} />
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

type Mode = 'idle' | 'approve' | 'reject';

function ApprovalCard({ item, now, onDone }: { item: ApprovalView; now: Date; onDone: (o: Outcome) => void }) {
  const venue = useVenue();
  const [mode, setMode] = useState<Mode>('idle');
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const locked = useLockActive(lockedUntil);
  const reason = approvalReason(item);

  function open(next: Mode): void {
    setMode(next);
    setError(null);
    setCode('');
  }

  async function approve(e: FormEvent): Promise<void> {
    e.preventDefault();
    // El código se envía solo al completarlo: un Intro a la vez no aprueba dos veces.
    if (busy) return;
    if (!/^\d{6}$/.test(code)) return setError('Pon los 6 números de tu app de verificación.');
    setBusy(true);
    setError(null);
    try {
      const result = await approveApproval(item.id, code);
      onDone(await afterApproved(item, result));
    } catch (err) {
      onApproveError(err);
    } finally {
      setBusy(false);
    }
  }

  function onApproveError(err: unknown): void {
    const lockEnds = totpLockedUntil(err, Date.now());
    if (lockEnds !== null) {
      setLockedUntil(lockEnds);
      setCode('');
    } else if (err instanceof ApiError && err.code === 'TOTP_INVALID') {
      setCode('');
    }
    if (err instanceof ApiError && err.code && FINAL_CODES.has(err.code)) {
      onDone({ tone: err.code === 'REFUND_OUTCOME_UNKNOWN' ? 'warning' : 'danger', text: err.message });
      return;
    }
    setError((err as Error).message);
  }

  async function reject(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const problem = rejectNoteProblem(note);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await rejectApproval(item.id, note.trim());
      onDone({ tone: 'info', text: `Rechazada. ${item.requestedBy.name} verá el motivo en «Mis solicitudes».` });
    } catch (err) {
      if (err instanceof ApiError && err.code && FINAL_CODES.has(err.code)) {
        onDone({ tone: 'danger', text: err.message });
        return;
      }
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="np-approval" data-kind={item.kind} data-mode={mode}>
      <p className="np-inbox-meta">
        <span className="np-inbox-kicker">{kindLabel(item)}</span>
        <span>
          {item.requestedBy.name} · {timeAgo(item.requestedAt, now)}
        </span>
      </p>
      <p className="np-approval-amount np-num">{formatEur(item.amountCents)}</p>
      <p className="np-approval-target">{approvalTarget(item, methodLabel)}</p>
      {reason ? <p className="np-approval-reason">«{reason}»</p> : null}
      <p className="np-approval-meta">
        {item.kind === 'PAYOUT'
          ? `${item.payout.earningCount === 1 ? '1 comisión' : `${item.payout.earningCount} comisiones`} · `
          : ''}
        {expiresIn(item.expiresAt, now)}
      </p>

      {!item.canDecide ? (
        <p className="np-approval-meta">La pediste tú: la aprueba otra persona.</p>
      ) : mode === 'approve' ? (
        <form onSubmit={(e) => void approve(e)} className="np-approval-form">
          <ConfirmLine>{approveSummary(item, venue.name ?? venue.slug, methodLabel)}</ConfirmLine>
          <OtpInput
            label="Código de tu app de verificación (2FA)"
            value={code}
            onChange={setCode}
            autoSubmit
            autoFocus
            required
            lockedUntil={lockedUntil}
            hint="Al poner el sexto número se aprueba. Cada código vale una sola vez."
          />
          {error ? (
            <p role="alert" className="np-approval-error">
              {error}
            </p>
          ) : null}
          <div className="np-approval-actions">
            <Button type="submit" loading={busy} disabled={locked}>
              Aprobar {formatEur(item.amountCents)}
            </Button>
            <Button variant="ghost" type="button" onClick={() => open('idle')} disabled={busy}>
              Cancelar
            </Button>
          </div>
        </form>
      ) : mode === 'reject' ? (
        <form onSubmit={(e) => void reject(e)} className="np-approval-form">
          <Input
            label="Por qué la rechazas (lo verá el encargado)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="ej: ya se le pagó en efectivo"
            autoFocus
            required
          />
          {error ? (
            <p role="alert" className="np-approval-error">
              {error}
            </p>
          ) : null}
          <div className="np-approval-actions">
            <Button type="submit" variant="danger" loading={busy}>
              Rechazar
            </Button>
            <Button variant="ghost" type="button" onClick={() => open('idle')} disabled={busy}>
              Cancelar
            </Button>
          </div>
        </form>
      ) : (
        <div className="np-approval-actions">
          <Button onClick={() => open('approve')}>Aprobar</Button>
          <Button variant="ghost" className="np-approval-reject" onClick={() => open('reject')}>
            Rechazar
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * Aprobado. Un pago que el encargado pidió ya con su referencia (hash o
 * justificante) se verifica o se confirma a mano como en «Marcar pagado».
 */
async function afterApproved(item: ApprovalView, result: ApprovalView): Promise<Outcome> {
  const text = approvedMessage(item);
  if (item.kind !== 'PAYOUT' || !result.resultRef || !item.payout.externalTxId || !item.payout.method) {
    return { tone: 'success', text };
  }
  const verified = await settle(result.resultRef, item.payout.method, item.payout.externalTxId, item.payout.receiptUrl ?? '');
  return { tone: verified.tone, text: `${text} ${verified.message}` };
}

function DecidedRow({ item, now }: { item: ApprovalView; now: Date }) {
  const status = APPROVAL_STATUS[item.status];
  return (
    <li className="np-approval" data-state="done">
      <p className="np-inbox-meta">
        <span className="np-inbox-kicker">{kindLabel(item)}</span>
        <Pill tone={status.tone}>{status.label}</Pill>
        <span>{item.requestedBy.name}</span>
      </p>
      <p className="np-approval-target">
        <strong className="np-num">{formatEur(item.amountCents)}</strong> · {approvalTarget(item, methodLabel)}
      </p>
      <p className="np-approval-meta">{decisionLine(item, now)}</p>
    </li>
  );
}

const groupStyle = { display: 'flex', flexDirection: 'column', gap: '0.75rem' } as const;
