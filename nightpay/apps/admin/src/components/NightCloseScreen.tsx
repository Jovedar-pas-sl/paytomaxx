'use client';

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Button, Icon, ScreenHelp } from '@nightpay/ui';
import { TOURS } from '@/lib/tours';
import type { NightChicaPay, NightCloseCheck, NightCloseStep, NightCloseStepKey } from '@nightpay/contracts';
import { NightCloseRefused, closeNight, countCash, fetchCloseCheck, type NightView, type PayoutMethod } from '@/lib/api';
import type { NightCashCountResult } from '@nightpay/contracts';
import { ApiError, totpRetryState } from '@/lib/api-errors';
import { formatDateTime } from '@/lib/dates';
import { sameValue } from '@/lib/diff';
import { bitcoinWalletLine, zClosedLines } from '@/lib/cobrado';
import { formatEur } from '@/lib/money';
import {
  STATUS_LABEL,
  ackedKeys,
  blindCountInput,
  closeCashInput,
  closeSteps,
  floatChangeCode,
  firstCountOf,
  firstCountToSend,
  freezeState,
  pasoAbierto,
  readyCount,
  stepTab,
  toggleAck,
  type CashDraft,
  type StepAck,
} from '@/lib/night-close';
import type { PanelTab, TabKey } from '@/lib/roles';
import { usePolling } from '@/lib/use-polling';
import { useVenueTimezone } from '@/lib/venue-context';
import { Z_NET_LABEL } from '@/lib/z-labels';
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
  /** La noche quedó cerrada (tras ver el informe Z ya fijo). */
  onClosed: () => void;
}

/**
 * Cerrar la noche en pasos (pantalla completa en el móvil): cobros sin
 * terminar, datáfonos, saldo por devolver, el arqueo de caja, pagar a las
 * chicas, incidencias y el informe Z. «Cerrar la noche» se habilita cuando
 * nada bloquea y los avisos están confirmados (mismas reglas que el API).
 * Lo que llega «Listo» en la primera carga sale plegado (pasoAbierto).
 */
export function NightCloseScreen({ night, isOwner, tabs, onNavigate, onClose, onClosed }: Props) {
  const tz = useVenueTimezone();
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [check, setCheck] = useState<NightCloseCheck | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<CashDraft>({ floatText: '', countedText: '' });
  // Cierre a ciegas (B9): lo esperado sale solo tras «Ver si cuadra» con lo contado escrito.
  // Después, lo contado queda fijo; «Volver a contar» guarda el primer recuento (va al Z).
  const [countDone, setCountDone] = useState(false);
  const [firstCount, setFirstCount] = useState<number | null>(null);
  // A ciegas (la encargada): lo que dijo el API con lo contado (si cuadra o la diferencia, sin lo esperado).
  const [blindCount, setBlindCount] = useState<NightCashCountResult | null>(null);
  const recount = () => {
    setFirstCount((prev) => firstCountOf(prev, draft));
    setDraft((prev) => ({ ...prev, countedText: '' }));
    setCountDone(false);
    setBlindCount(null);
  };
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
  /** Los pasos que llegaron «Listo» en la primera carga (salen plegados). */
  const [firstReady, setFirstReady] = useState<ReadonlySet<NightCloseStepKey> | null>(null);
  /** Las filas que se tocaron: abiertas (true) o plegadas (false). */
  const [chosen, setChosen] = useState<Partial<Record<NightCloseStepKey, boolean>>>({});

  const refresh = usePolling(
    async (signal) => {
      try {
        const next = await fetchCloseCheck();
        if (signal.aborted) return true;
        setLoadError(null);
        // La primera carga, sin nada tecleado: lo que ya está listo sale plegado.
        setFirstReady(
          (prev) =>
            prev ??
            new Set(
              closeSteps(next.steps, next.cash, { floatText: '', countedText: '' }, { countDone: false, floatApproved: false })
                .filter((st) => st.status === 'ok')
                .map((st) => st.key),
            ),
        );
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
  const steps = check ? closeSteps(check.steps, check.cash, draft, { countDone, floatApproved, blindCount }) : [];
  // «Ver si cuadra»: a ciegas, lo pregunta al API (queda en el registro); si no, se ve aquí.
  async function countDoneNow() {
    if (!check?.cash.cashHidden) {
      setCountDone(true);
      return;
    }
    const input = blindCountInput(draft);
    if (!input) return;
    setBusy(true);
    setError(null);
    try {
      setBlindCount(await countCash(input));
      setCountDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
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
    const cash = closeCashInput(draft, countDone);
    try {
      const view = await closeNight(night.id, {
        acknowledged: acks,
        note: note.trim() || undefined,
        cashCountedCents: cash.countedCents ?? undefined,
        cashFirstCountedCents: firstCountToSend(firstCount, countDone),
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
        <ol className="np-close-steps" data-tour="cierre-pasos">
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
              open={pasoAbierto({ key: step.key, status: step.status, listoAlCargar: firstReady?.has(step.key) ?? false, elegido: chosen[step.key] })}
              onToggle={(open) => setChosen((prev) => ({ ...prev, [step.key]: open }))}
            >
              {step.key === 'efectivo' ? (
                <>
                {/* El bitcoin de la noche (el del mapa del dinero): ni caja ni banco, no se cuenta. */}
                {check.bitcoinCents !== undefined ? (
                  <p className="np-close-btc" role="note">
                    {bitcoinWalletLine(check.bitcoinCents, formatEur)}. No es efectivo ni va al banco: no lo cuentes con la caja.
                  </p>
                ) : null}
                <NightCashStep
                  cash={check.cash}
                  draft={draft}
                  onDraft={setDraft}
                  cashNote={cashNote}
                  onCashNote={setCashNote}
                  acked={acks.includes('efectivo')}
                  onAck={(on) => ackStep('efectivo', on)}
                  countDone={countDone}
                  onCountDone={() => void countDoneNow()}
                  blindCount={blindCount}
                  onRecount={recount}
                  firstCountCents={firstCount}
                  disabled={busy}
                  isOwner={isOwner}
                  floatCode={floatCode}
                  onFloatCode={setFloatCode}
                  floatCodeLockedUntil={floatLockedUntil}
                />
                </>
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
    <div className="np-close" role="dialog" aria-modal="true" aria-labelledby={titleId} data-tour-host="">
      <div className="np-close-panel">
        <header className="np-close-head">
          <div className="np-close-head-row">
            <p className="np-close-kicker">
              {closed?.closedAt
                ? `Abierta a las ${formatDateTime(night.openedAt, tz, 'time')} · cerrada a las ${formatDateTime(closed.closedAt, tz, 'time')}`
                : `Noche abierta desde las ${formatDateTime(night.openedAt, tz, 'time')}`}
            </p>
            {closed ? null : <ScreenHelp {...TOURS.nightClose} delayMs={1500} />}
            <button
              type="button"
              className="np-modal-close"
              aria-label={closed ? 'Volver' : 'Volver sin cerrar'}
              onClick={closed ? onClosed : onClose}
              disabled={busy}
            >
              <Icon name="close" size={20} />
            </button>
          </div>
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className="np-close-title">
            {closed ? 'Noche cerrada' : 'Cerrar la noche'}
          </h2>
          {check && !closed ? (
            <div className="np-close-progress" data-tour="cierre-progreso" aria-label={`${ready} de ${steps.length} pasos listos`}>
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
            <Button size="lg" className="np-close-freeze" onClick={() => void freezeZ()} disabled={!freeze.canFreeze} loading={busy} data-tour="cierre-congelar">
              Cerrar la noche
            </Button>
            <p className="np-close-hint" aria-live="polite">
              {freeze.reason ?? 'Todo listo. Al cerrar, el informe Z y la caja de esta noche quedan fijos.'}
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
          payoutAddressMasked={payFor.payoutAddressMasked ?? null}
          payoutHoldUntil={payFor.payoutHoldUntil ?? null}
          canReveal={isOwner}
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
  open,
  onToggle,
  children,
}: {
  n: number;
  step: NightCloseStep;
  tab: PanelTab | null;
  onGo: (key: TabKey) => void;
  acked: boolean;
  onAck: (on: boolean) => void;
  disabled: boolean;
  /** pasoAbierto: plegado, un paso listo es una fila de 48 que se abre al tocarla. */
  open: boolean;
  onToggle: (open: boolean) => void;
  children?: ReactNode;
}) {
  const ackId = useId();
  const bodyId = useId();
  // Se pliega lo que está listo (el informe Z, nunca).
  const foldable = step.status === 'ok' && step.key !== 'z';
  if (foldable && !open) {
    return (
      <li className="np-close-step" data-status={step.status} data-folded="">
        <button type="button" className="np-close-fold" aria-expanded={false} onClick={() => onToggle(true)}>
          <span className="np-close-mark" aria-hidden="true">
            <Icon name="check" size={20} />
          </span>
          <span className="np-close-fold-title">
            <span className="np-close-step-n">{n}</span>
            {step.title}
          </span>
          <span className="np-close-badge" data-status={step.status}>
            {STATUS_LABEL[step.status]}
          </span>
          <Icon name="chevron-right" size={20} className="np-close-fold-arrow" />
        </button>
      </li>
    );
  }
  // Efectivo y chicas enseñan lo suyo; el resto, la lista de lo que falta.
  const items = step.key === 'efectivo' || step.key === 'chicas' ? [] : step.items;
  return (
    <li className="np-close-step" data-status={step.status}>
      <span className="np-close-mark" aria-hidden="true">
        <StatusIcon status={step.status} />
      </span>
      <div className="np-close-step-body" id={bodyId}>
        <div className="np-close-step-top">
          <h3 className="np-close-step-title">
            {foldable ? (
              <button type="button" className="np-close-step-toggle" aria-expanded={true} aria-controls={bodyId} onClick={() => onToggle(false)}>
                <span className="np-close-step-n">{n}</span>
                {step.title}
              </button>
            ) : (
              <>
                <span className="np-close-step-n">{n}</span>
                {step.title}
              </>
            )}
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
  // Como el resumen de las 9:00: lo cobrado con su desglose y, aparte, lo pagado con tarjeta. El
  // neto, con su nombre del Z: no es el «neto sin el personal» del resumen.
  const lines = zClosedLines(s, formatEur);
  return (
    <div className="np-close-done">
      <p className="np-close-done-lead">
        Noche cerrada a las {night.closedAt ? formatDateTime(night.closedAt, tz, 'time') : '—'}. El informe Z queda fijo.
      </p>
      <p className="np-close-done-lead">
        {lines.cobrado} · {Z_NET_LABEL}:{' '}
        <strong className="np-num">{formatEur(s.netCents)}</strong>.
      </p>
      <p className="np-close-done-lead">{lines.card}</p>
      {lines.bitcoin ? <p className="np-close-done-lead">{lines.bitcoin}</p> : null}
      {night.z.caja ? <NightCajaBlock caja={night.z.caja} /> : null}
      {night.pendingAtClose > 0 ? (
        <Notice tone="warning">
          {night.pendingAtClose === 1 ? 'Quedó 1 cobro' : `Quedaron ${night.pendingAtClose} cobros`} sin terminar: sale en
          Avisos hasta que se resuelva.
        </Notice>
      ) : null}
      <Button onClick={onDone}>Volver</Button>
    </div>
  );
}

/** Visto, aviso o bloqueo (además del texto: no solo color), los de Etiqueta. */
function StatusIcon({ status }: { status: NightCloseStep['status'] }) {
  return <Icon name={status === 'ok' ? 'check' : status === 'warn' ? 'alert' : 'error'} size={20} />;
}

/**
 * Pantalla encima del panel: foco en el título al abrir, Esc para volver,
 * sin scroll de fondo, el resto del panel inerte (Tab no sale de la
 * pantalla, P-4) y el foco vuelve a donde estaba al cerrarla.
 */
function useModalScreen(headingRef: RefObject<HTMLHeadingElement | null>, onEscape: () => void): void {
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus();
    // Lo de fuera de la pantalla (va en un portal, hija de <body>): inerte mientras está abierta.
    const dialog = headingRef.current?.closest('[role="dialog"]') ?? null;
    const outside = dialog
      ? Array.from(document.body.children).filter((el): el is HTMLElement => el instanceof HTMLElement && !el.contains(dialog) && !el.inert)
      : [];
    for (const el of outside) el.inert = true;
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
      for (const el of outside) el.inert = false;
      if (previous?.isConnected) previous.focus();
    };
  }, [headingRef]);
}
