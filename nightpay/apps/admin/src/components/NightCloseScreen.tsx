'use client';

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@nightpay/ui';
import type { NightChicaPay, NightCloseCheck, NightCloseStep, NightCloseStepKey } from '@nightpay/contracts';
import { NightCloseRefused, closeNight, fetchCloseCheck, type NightView, type PayoutMethod } from '@/lib/api';
import { ApiError, totpRetryState } from '@/lib/api-errors';
import { formatDateTime } from '@/lib/dates';
import { sameValue } from '@/lib/diff';
import { formatEur } from '@/lib/money';
import {
  STATUS_LABEL,
  ackedKeys,
  cashInputOf,
  effectiveSteps,
  floatChangeCode,
  freezeState,
  readyCount,
  stepTab,
  toggleAck,
  type CashDraft,
  type StepAck,
} from '@/lib/night-close';
import type { PanelTab, TabKey } from '@/lib/roles';
import { usePolling } from '@/lib/use-polling';
import { useVenueTimezone } from '@/lib/venue-context';
import { NightCajaBlock } from './NightCajaBlock';
import { NightCashStep } from './NightCashStep';
import { NightChicasStep } from './NightChicasStep';
import { Notice } from './Notice';
import { PayoutConfirmModal } from './PayoutConfirmModal';

const REFRESH_MS = 30_000;
const ITEMS_SHOWN = 6;

interface Props {
  night: NightView;
  /** El dueño: puede aprobar con su 2FA cambiar el fondo apuntado al abrir. */
  isOwner: boolean;
  tabs: ReadonlyArray<PanelTab>;
  onNavigate: (key: TabKey) => void;
  /** Volver sin cerrar. */
  onClose: () => void;
  /** La noche quedó cerrada (tras ver el Z congelado). */
  onClosed: () => void;
}

/**
 * Cerrar la noche en pasos (pantalla completa en el móvil): cobros sin
 * terminar, datáfonos, saldo por devolver, el arqueo de caja, pagar a las
 * chicas, incidencias y congelar el Z. «Congelar el Z» se habilita cuando
 * nada bloquea y los avisos están confirmados (mismas reglas que el API).
 */
export function NightCloseScreen({ night, isOwner, tabs, onNavigate, onClose, onClosed }: Props) {
  const tz = useVenueTimezone();
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [check, setCheck] = useState<NightCloseCheck | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<CashDraft>({ floatText: '', countedText: '' });
  const [cashNote, setCashNote] = useState('');
  // Fondo cambiado al cerrar: el código 2FA del dueño (y hasta cuándo no deja probar otro).
  const [floatCode, setFloatCode] = useState('');
  const [floatLockedUntil, setFloatLockedUntil] = useState<number | null>(null);
  const [note, setNote] = useState('');
  // Cada aviso confirmado con su huella: si el paso cambia (otro importe u otro recuento), hay que volver a confirmarlo.
  const [ackList, setAckList] = useState<StepAck[]>([]);
  const [payFor, setPayFor] = useState<NightChicaPay | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState<NightView | null>(null);

  const refresh = usePolling(
    async (signal) => {
      try {
        const next = await fetchCloseCheck();
        if (signal.aborted) return true;
        setLoadError(null);
        // generatedAt cambia en cada vuelta: si lo demás es igual, no se repinta.
        setCheck((prev) => (prev && sameValue({ ...prev, generatedAt: '' }, { ...next, generatedAt: '' }) ? prev : next));
        return true;
      } catch (err) {
        if (!signal.aborted) setLoadError((err as Error).message);
        return false;
      }
    },
    { intervalMs: REFRESH_MS, enabled: closed === null && payFor === null && !busy },
    [],
  );

  useModalScreen(headingRef, () => {
    if (!busy && payFor === null) (closed ? onClosed : onClose)();
  });

  const floatChange = check ? floatChangeCode(check.cash, draft, { isOwner, code: floatCode }) : { needed: false as const };
  const floatApproved = floatChange.needed && floatChange.code !== undefined;
  const steps = check ? effectiveSteps(check.steps, check.cash, draft, floatApproved) : [];
  const acks = ackedKeys(ackList, steps);
  const ackStep = (key: NightCloseStepKey, on: boolean) => {
    const step = steps.find((s) => s.key === key);
    if (step) setAckList((prev) => toggleAck(prev, step, on));
  };
  const freeze = freezeState(steps, acks, note);
  const ready = readyCount(steps, acks);

  async function freezeZ() {
    setBusy(true);
    setError(null);
    const cash = cashInputOf(draft);
    try {
      const view = await closeNight(night.id, {
        acknowledged: acks,
        note: note.trim() || undefined,
        cashCountedCents: cash.countedCents ?? undefined,
        openingFloatCents: cash.openingFloatCents ?? undefined,
        cashNote: cashNote.trim() || undefined,
        totpCode: floatChange.needed ? floatChange.code : undefined,
      });
      setClosed(view);
    } catch (err) {
      // El código del dueño no valía (o hay que esperar): se pide otro.
      if (floatChange.needed) {
        const retry = totpRetryState(err, Date.now());
        if (retry.lockedUntil !== null) setFloatLockedUntil(retry.lockedUntil);
        if (retry.askCode || (err instanceof ApiError && err.code === 'TOTP_INVALID')) setFloatCode('');
      }
      // El API recalculó los pasos: se enseñan los suyos (pueden haber cambiado).
      if (err instanceof NightCloseRefused && check) {
        setCheck({ ...check, steps: err.steps });
      }
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function goTo(key: TabKey) {
    onClose();
    onNavigate(key);
  }

  const content = closed ? (
    <ClosedResult night={closed} onDone={onClosed} />
  ) : (
    <>
      {loadError && !check ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: refresh }}>
          No se pudieron cargar los pasos: {loadError}
        </Notice>
      ) : null}
      {!check ? (
        loadError ? null : <p className="np-close-hint">Cargando los pasos…</p>
      ) : (
        <ol className="np-close-steps">
          {steps.map((step, i) => (
            <StepCard
              key={step.key}
              n={i + 1}
              step={step}
              tab={stepTab(step.link, tabs)}
              onGo={goTo}
              acked={acks.includes(step.key)}
              onAck={(on) => ackStep(step.key, on)}
              disabled={busy}
            >
              {step.key === 'efectivo' ? (
                <NightCashStep
                  cash={check.cash}
                  draft={draft}
                  onDraft={setDraft}
                  cashNote={cashNote}
                  onCashNote={setCashNote}
                  acked={acks.includes('efectivo')}
                  onAck={(on) => ackStep('efectivo', on)}
                  disabled={busy}
                  isOwner={isOwner}
                  floatCode={floatCode}
                  onFloatCode={setFloatCode}
                  floatCodeLockedUntil={floatLockedUntil}
                />
              ) : step.key === 'chicas' ? (
                <NightChicasStep chicas={check.chicas} holdDays={check.holdDays} onPay={setPayFor} disabled={busy} />
              ) : step.key === 'cobros' && freeze.noteRequired ? (
                <label className="np-close-field">
                  <span className="np-cash-label">Por qué cierras con cobros sin terminar</span>
                  <input
                    className="np-close-text"
                    value={note}
                    maxLength={300}
                    placeholder="ej: BBVA lo confirma mañana"
                    onChange={(e) => setNote(e.target.value)}
                    disabled={busy}
                  />
                </label>
              ) : null}
            </StepCard>
          ))}
        </ol>
      )}
    </>
  );

  const screen = (
    <div className="np-close" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="np-close-panel">
        <header className="np-close-head">
          <div className="np-close-head-row">
            <p className="np-close-kicker">
              {closed?.closedAt
                ? `Abierta a las ${formatDateTime(night.openedAt, tz, 'time')} · cerrada a las ${formatDateTime(closed.closedAt, tz, 'time')}`
                : `Noche abierta desde las ${formatDateTime(night.openedAt, tz, 'time')}`}
            </p>
            <button
              type="button"
              className="np-modal-close"
              aria-label={closed ? 'Volver a Noches' : 'Volver sin cerrar'}
              onClick={closed ? onClosed : onClose}
              disabled={busy}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className="np-close-title">
            {closed ? 'Noche cerrada' : 'Cerrar la noche'}
          </h2>
          {check && !closed ? (
            <div className="np-close-progress" aria-label={`${ready} de ${steps.length} pasos listos`}>
              <span className="np-close-progress-bar" style={{ transform: `scaleX(${ready / Math.max(1, steps.length)})` }} />
              <span className="np-close-progress-text">
                {ready} de {steps.length} listos
              </span>
            </div>
          ) : null}
        </header>

        <div className="np-close-body">{content}</div>

        {check && !closed ? (
          <footer className="np-close-foot">
            {error ? (
              <p role="alert" className="np-close-error">
                {error}
              </p>
            ) : null}
            <Button size="lg" className="np-close-freeze" onClick={() => void freezeZ()} disabled={!freeze.canFreeze} loading={busy}>
              Congelar el Z
            </Button>
            <p className="np-close-hint" aria-live="polite">
              {freeze.reason ?? 'Todo listo: al congelarlo, el Z y la caja de esta noche ya no cambian.'}
            </p>
          </footer>
        ) : null}
      </div>

      {payFor ? (
        <PayoutConfirmModal
          operatorId={payFor.operatorId}
          operatorName={payFor.name}
          balanceCents={payFor.toPayCents}
          payoutMethod={(payFor.payoutMethod as PayoutMethod | null) ?? null}
          payoutAddress={payFor.payoutAddress}
          payoutLabel={payFor.payoutLabel}
          onClose={() => setPayFor(null)}
          onDone={() => {
            setPayFor(null);
            refresh();
          }}
        />
      ) : null}
    </div>
  );

  return typeof document === 'undefined' ? screen : createPortal(screen, document.body);
}

function StepCard({
  n,
  step,
  tab,
  onGo,
  acked,
  onAck,
  disabled,
  children,
}: {
  n: number;
  step: NightCloseStep;
  tab: PanelTab | null;
  onGo: (key: TabKey) => void;
  acked: boolean;
  onAck: (on: boolean) => void;
  disabled: boolean;
  children?: ReactNode;
}) {
  const ackId = useId();
  // Efectivo y chicas enseñan lo suyo; el resto, la lista de lo que falta.
  const items = step.key === 'efectivo' || step.key === 'chicas' ? [] : step.items;
  return (
    <li className="np-close-step" data-status={step.status}>
      <span className="np-close-mark" aria-hidden="true">
        <StatusIcon status={step.status} />
      </span>
      <div className="np-close-step-body">
        <div className="np-close-step-top">
          <h3 className="np-close-step-title">
            <span className="np-close-step-n">{n}</span>
            {step.title}
          </h3>
          <span className="np-close-badge" data-status={step.status}>
            {STATUS_LABEL[step.status]}
            {step.count > 0 && step.key !== 'efectivo' ? ` · ${step.count}` : ''}
          </span>
        </div>
        <p className="np-close-step-detail">{step.detail}</p>
        {items.length > 0 ? (
          <ul className="np-close-items">
            {items.slice(0, ITEMS_SHOWN).map((item) => (
              <li key={item.id} data-status={item.status}>
                {item.label}
              </li>
            ))}
            {items.length > ITEMS_SHOWN ? <li data-status="ok">y {items.length - ITEMS_SHOWN} más</li> : null}
          </ul>
        ) : null}
        {children}
        {tab || (step.status === 'warn' && step.key !== 'efectivo') ? (
          <div className="np-close-step-actions">
            {tab && step.status !== 'ok' ? (
              <Button variant="ghost" className="np-close-go" onClick={() => onGo(tab.key)} disabled={disabled}>
                Ir a {tab.label}
              </Button>
            ) : null}
            {step.status === 'warn' && step.key !== 'efectivo' ? (
              <label htmlFor={ackId} className="np-close-ack">
                <input id={ackId} type="checkbox" checked={acked} onChange={(e) => onAck(e.target.checked)} disabled={disabled} />
                <span>Lo he visto: cerrar igualmente</span>
              </label>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function ClosedResult({ night, onDone }: { night: NightView; onDone: () => void }) {
  const tz = useVenueTimezone();
  const s = night.z.summary;
  return (
    <div className="np-close-done">
      <p className="np-close-done-lead">
        Z congelado a las {night.closedAt ? formatDateTime(night.closedAt, tz, 'time') : '—'}: {s.count} cobros ·
        cobrado <strong className="np-num">{formatEur(s.chargedCents)}</strong> · neto{' '}
        <strong className="np-num">{formatEur(s.netCents)}</strong>.
      </p>
      {night.z.caja ? <NightCajaBlock caja={night.z.caja} /> : null}
      {night.pendingAtClose > 0 ? (
        <Notice tone="warning">
          {night.pendingAtClose === 1 ? 'Quedó 1 cobro' : `Quedaron ${night.pendingAtClose} cobros`} sin terminar: sale en
          Incidencias hasta que se resuelva.
        </Notice>
      ) : null}
      <Button onClick={onDone}>Volver a Noches</Button>
    </div>
  );
}

/** Tick, aviso o bloqueo (además del texto: no solo color). */
function StatusIcon({ status }: { status: NightCloseStep['status'] }) {
  const common = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.4 } as const;
  if (status === 'ok') {
    return (
      <svg {...common}>
        <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === 'warn') {
    return (
      <svg {...common}>
        <path d="M12 8v5M12 16.5h.01" strokeLinecap="round" />
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6l12.8 12.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Pantalla encima del panel: foco en el título al abrir, Esc para volver,
 * sin scroll de fondo, y el foco vuelve a donde estaba al cerrarla.
 */
function useModalScreen(headingRef: RefObject<HTMLHeadingElement | null>, onEscape: () => void): void {
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      // Con el modal de pago abierto, Esc es suyo.
      if (document.querySelector('.np-modal-panel')) return;
      escape.current();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [headingRef]);
}
