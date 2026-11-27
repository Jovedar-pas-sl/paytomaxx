'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button, formatRelative, FormError, Input, useNow } from '@nightpay/ui';
import { PASSKEY_REQUIRED_CODE, stepUpActions, type PayoutMethod, type StepUpProof } from '@nightpay/contracts';
import { approveApproval, fetchApprovals, rejectApproval, type ApprovalView } from '@/lib/api';
import { ApiError, totpLockedUntil } from '@/lib/api-errors';
import {
  APPROVAL_STATUS,
  approvalAutoSends,
  approvalReason,
  approvalTarget,
  approveButtonText,
  approveFailure,
  approveSummary,
  approvedMessage,
  decisionLine,
  expiresIn,
  kindLabel,
  rejectNoteProblem,
} from '@/lib/approvals';
import { formatEur } from '@/lib/money';
import { proofFor } from '@/lib/refund-confirm';
import { useApprovals } from '@/lib/use-approvals';
import { useLockActive } from '@/lib/use-lock';
import { useStepUpMethod } from '@/lib/use-step-up-method';
import { useVenue, useVenueTimezone } from '@/lib/venue-context';
import { ConfirmLine } from './ConfirmLine';
import { KeyConfirm } from './KeyConfirm';
import { Notice } from './Notice';
import { OtpInput } from './OtpInput';
import { settle } from './PayoutConfirmModal';
import { PAYOUT_METHOD_SHORT } from './PayoutMethodForm';
import { Pill, type Tone } from './Pill';

const methodLabel = (m: PayoutMethod) => PAYOUT_METHOD_SHORT[m] ?? m;
/** Lo decidido que se enseña debajo. */
const RECENT_LIMIT = 10;
/** Ya no se puede decidir desde la tarjeta (otra persona, caducada…): se cuenta arriba y se refresca. */
const FINAL_CODES = new Set(['APPROVAL_FAILED', 'APPROVAL_NOT_PENDING', 'APPROVAL_EXPIRED']);

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
  const outcomeBox = useRef<HTMLDivElement>(null);
  const recentRun = useRef(0);
  const pendingId = useId();
  const recentId = useId();
  const now = new Date(useNow(true, 30_000));

  const loadRecent = useCallback(async () => {
    const run = ++recentRun.current;
    try {
      const items = await fetchApprovals(undefined, 50);
      // Una respuesta vieja que llega tarde no pisa la nueva.
      if (run === recentRun.current) {
        setRecent(items.filter((i) => i.status !== 'PENDING').slice(0, RECENT_LIMIT));
      }
    } catch {
      // Lo decidido es solo para mirar: si falla, se queda lo de antes.
    }
  }, []);

  // En el móvil la tarjeta desaparece al decidirla: el resultado se trae a la vista (y el foco).
  useEffect(() => {
    if (!outcome) return;
    outcomeBox.current?.scrollIntoView({ block: 'nearest' });
    outcomeBox.current?.focus({ preventScroll: true });
  }, [outcome]);

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
        <h2 className="np-approvals-title" data-tour="aprobar-titulo">Por aprobar</h2>
      </div>

      {outcome ? (
        <div ref={outcomeBox} tabIndex={-1} className="np-approvals-outcome">
          <Notice tone={outcome.tone} action={{ label: 'Entendido', onClick: () => setOutcome(null) }}>
            {outcome.text}
          </Notice>
        </div>
      ) : null}
      {feed.error ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: refresh }}>
          No se pudieron cargar las solicitudes: {feed.error}
        </Notice>
      ) : null}

      <section aria-labelledby={pendingId} style={groupStyle} data-tour="aprobar-pendientes">
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
  /** Sin 2FA activada: el formulario no sirve, se dice dónde activarla. */
  const [needsEnrol, setNeedsEnrol] = useState<string | null>(null);
  /** Se sube tras un código malo: el campo vuelve a montarse vacío y con el foco (teclado abierto). */
  const [otpKey, setOtpKey] = useState(0);
  /** Una petición en marcha: el sexto número y un Intro a la vez no aprueban dos veces. */
  const inFlight = useRef(false);
  const locked = useLockActive(lockedUntil);
  const reason = approvalReason(item);
  // Sin 2FA y con llave de acceso: se confirma con ella (el API la acepta para esta solicitud).
  const method = useStepUpMethod(mode === 'approve');
  const [askedForKey, setAskedForKey] = useState(false);
  const [proof, setProof] = useState<StepUpProof | null>(null);
  const withKey = method === 'passkey' || askedForKey;
  const keyProof = withKey ? proofFor(proof, stepUpActions.approve(item.id), Date.now()) : null;
  // Una devolución desde 100 € no sale sola: con el botón que dice el importe.
  const autoSends = approvalAutoSends(item);
  const buttonText = approveButtonText(item, formatEur);

  function open(next: Mode): void {
    setMode(next);
    setError(null);
    setCode('');
    setProof(null);
  }

  function approve(e: FormEvent): void {
    e.preventDefault();
    void send(keyProof);
  }

  /** Confirmado con la llave: si se aprueba sola, ya; si no, el botón. */
  function onKeyProof(next: StepUpProof): void {
    setProof(next);
    if (autoSends) void send(next);
  }

  async function send(withProof: StepUpProof | null): Promise<void> {
    if (inFlight.current) return;
    if (withKey && !withProof) return setError('Confírmalo antes con tu llave de acceso.');
    if (!withKey && !/^\d{6}$/.test(code)) return setError('Pon los 6 números de tu app de verificación.');
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await approveApproval(item.id, withKey ? undefined : code, withKey ? withProof?.token : undefined);
      onDone(await afterApproved(item, result));
    } catch (err) {
      onApproveError(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function onApproveError(err: unknown): void {
    if (err instanceof ApiError && err.code === PASSKEY_REQUIRED_CODE) {
      // Sin 2FA y con llave: se confirma con ella.
      setAskedForKey(true);
      setProof(null);
      setError(autoSends ? 'Confírmalo con tu llave de acceso.' : `Confírmalo con tu llave de acceso y después pulsa «${buttonText}».`);
      return;
    }
    const lockEnds = totpLockedUntil(err, Date.now());
    if (lockEnds !== null) {
      setLockedUntil(lockEnds);
      setCode('');
      setError((err as Error).message);
      return;
    }
    const failure = approveFailure(
      err instanceof ApiError ? { status: err.status, code: err.code, message: err.message } : null,
    );
    if (failure.kind === 'done') return onDone({ tone: failure.tone, text: failure.text });
    if (failure.kind === 'enrol') return setNeedsEnrol(failure.text);
    if (failure.clearCode) {
      setCode('');
      setOtpKey((k) => k + 1);
    }
    setError(failure.text);
  }

  async function reject(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (inFlight.current) return;
    const problem = rejectNoteProblem(note);
    if (problem) return setError(problem);
    inFlight.current = true;
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
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <li className="np-approval" data-kind={item.kind} data-mode={mode}>
      <p className="np-inbox-meta">
        <span className="np-inbox-kicker">{kindLabel(item)}</span>
        <span>
          {item.requestedBy.name} · {formatRelative(item.requestedAt, now, venue.timezone)}
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
      ) : needsEnrol ? (
        <FormError>
          {needsEnrol}
        </FormError>
      ) : mode === 'approve' ? (
        <form onSubmit={(e) => void approve(e)} className="np-approval-form">
          <ConfirmLine>{approveSummary(item, venue.name ?? venue.slug, methodLabel)}</ConfirmLine>
          {withKey ? (
            <KeyConfirm
              action={stepUpActions.approve(item.id)}
              confirmed={Boolean(keyProof)}
              onProof={onKeyProof}
              reason={`Para aprobar ${item.kind === 'REFUND' ? 'la devolución' : 'el pago'} de ${formatEur(item.amountCents)}.`}
              next={autoSends ? 'Se está aprobando.' : `Ahora pulsa «${buttonText}».`}
            />
          ) : (
            <OtpInput
              key={otpKey}
              label="Código de tu app de verificación (2FA)"
              value={code}
              onChange={setCode}
              autoSubmit={autoSends}
              autoFocus
              required
              disabled={busy}
              lockedUntil={lockedUntil}
              hint={
                autoSends
                  ? 'Al poner el sexto número se aprueba. Cada código vale una sola vez.'
                  : `Pon los 6 números y pulsa «${buttonText}»: desde 100 € no se aprueba sola. Cada código vale una sola vez.`
              }
            />
          )}
          {error ? (
            <FormError>
              {error}
            </FormError>
          ) : null}
          <div className="np-approval-actions">
            <Button type="submit" loading={busy} disabled={(!withKey && locked) || (withKey && !keyProof)}>
              {buttonText}
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
            <FormError>
              {error}
            </FormError>
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
  const tz = useVenueTimezone();
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
      <p className="np-approval-meta">{decisionLine(item, now, tz)}</p>
    </li>
  );
}

const groupStyle = { display: 'flex', flexDirection: 'column', gap: '0.75rem' } as const;
