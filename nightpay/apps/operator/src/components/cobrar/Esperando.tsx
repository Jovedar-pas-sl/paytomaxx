'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { confirmationCode, type PaymentStatus } from '@nightpay/contracts';
import {
  countdownPhase,
  formatClock,
  qrDeadline,
  remainingFraction,
  secondsLeft,
  useNow,
  useWakeLock,
} from '@nightpay/ui';
import { formatEur } from '@/lib/money';
import { nfcSupported, readCard, waitingListensNfc } from '@/lib/nfc';
import { useHealthReport } from '@/lib/connection-health';
import { useOpenCharge } from '@/lib/open-charges';
import { advanceStatus } from '@/lib/payment-status';
import { useVenueMethods, useVenueNight } from '@/lib/venue-methods';
import { useWalletChargeLive } from '../use-wallet-charge-live';
import {
  CobroApiError,
  cancelCard,
  cancelSaldo,
  fetchSaldoState,
  lookupNfc,
  payByNfc,
  payByPin,
  payFailureKind,
  type CobroCreado,
  type SaldoState,
} from '@/lib/api-cobro';
import {
  CHECKING_TEXT,
  NOT_CHARGED_RETRY_TEXT,
  failReasonOf,
  paidAmounts,
  paidBreakdown,
  paidMeta,
  pinExpected,
  pinWarning,
  tipLine,
  waitingFeeHint,
  waitingLiveText,
  type FailReason,
} from '@/lib/cobro-view';
import {
  CANCEL_WHILE_PAYING_TEXT,
  UNCONFIRMED_SENTENCE,
  UNCONFIRMED_TITLE,
  cardWait,
  cardWaitParts,
  cobroOutcome,
  serverToLocalMs,
  showsBankStrip,
} from '@/lib/cobro-state';
import { fetchBankRef, notifiedText, notifyManager, type BankRef } from '@/lib/api-bank-wait';
import { useShown } from '../reception/desk/use-shown';
import { StaffOutcome } from '../StaffOutcome';
import { usePaymentLive } from '../use-payment-live';
import { colorOf } from './cobrar-context';
import { IconLock, IconQr } from './icons';
import { NfcCard } from './NfcCard';
import { PinScreen } from './PinScreen';
import styles from './cobrar.module.css';

/** Lo que hay que enseñar de un cobro abierto (lo pone quien lo crea). */
export interface CobroAbierto {
  /** El cobro con tarjeta (su QR abre la página de pago). Null: el local cobra solo con saldo. */
  card: CobroCreado | null;
  /** El cobro del saldo (el enlazado o el suelto): lo pagan el NFC y su PIN. */
  saldo: { chargeId: string; expiresAt: string } | null;
  /** El QR del cobro del saldo suelto (sin tarjeta). */
  saldoQr?: string | null;
  /** Lo que paga el cliente (con la propina que se puso en la cuenta, si la hay). */
  totalCents: number;
  /** La propina que se puso en la cuenta (va dentro de totalCents). */
  tipCents?: number;
  ref: string | null;
  /** Secciones del cobro con su importe: la banda, la franja y el chip. */
  sections: ReadonlyArray<{ section: string; cents: number }>;
  /** «COPAS» · «2 copas · Carlos» (o «INVITACIÓN» · «Nerea · Carlos»). */
  band: { title: string; detail: string };
  /** «2 copas» (el PAGADO). */
  what: string;
  /** Quien cobra (el PAGADO y el PIN). */
  who: string;
  /** «Servicios · Lola» (el chip del PIN). */
  pinChip: string;
  /** «Copa con invitación»: a quién y cómo se reparte. */
  invitation?: { chica: string; cells: ReadonlyArray<{ label: string; cents: number }> } | null;
}

interface Props {
  cobro: CobroAbierto;
  /** «Nuevo cobro». */
  onNew: () => void;
  /** «Otro QR · mismo importe»: otro cobro igual. */
  onRetry: () => void;
  retrying?: boolean;
  retryError?: string | null;
  /** Ya pagado: refrescar lo de la chica. */
  onPaid: () => void;
  /**
   * El nombre de cada sección (el del local, Ajustes → Secciones) en el chip
   * de PAGADO / NO PAGADO / CADUCADO: el mismo que la banda.
   */
  sectionLabel: (code: string) => string;
}

/** Tras una consulta del cobro del saldo fallida (servidor caído, 429). */
const SALDO_POLL_SLOW_MS = 4000;
const TOAST_MS = 4000;

type PinStep = { card: string; uid: string | null; code: string; reason: string | null };

/**
 * Esperando (maqueta 3.1): el importe, el QR y el NFC a la vez, sin elegir
 * nada. El QR abre la página de pago (tarjeta, o «Pagar con mi saldo») y el
 * NFC acercado por detrás paga el cobro del saldo enlazado; gana el primero.
 * El PIN, solo si el API lo pide (3.2). El resultado a pantalla completa:
 * PAGADO (3.3) o NO PAGADO con la razón y una salida (3.4). Pantalla siempre
 * encendida. En iPhone (sin NFC en la web), solo QR.
 */
export function Esperando({ cobro, onNew, onRetry, retrying = false, retryError = null, onPaid, sectionLabel }: Props) {
  const methods = useVenueMethods();
  const [cardStatus, setCardStatus] = useState<PaymentStatus>((cobro.card?.status as PaymentStatus) ?? 'CREATED');
  // La propina del cliente con tarjeta: undefined hasta que la diga el API (no es 0).
  const [cardTip, setCardTip] = useState<number | undefined>(undefined);
  const [saldo, setSaldo] = useState<SaldoState | null>(null);
  const [localFail, setLocalFail] = useState<FailReason | null>(null);
  const [canceledByMe, setCanceledByMe] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [pin, setPin] = useState<PinStep | null>(null);
  const [reading, setReading] = useState(false);
  const [nfcRound, setNfcRound] = useState(0);
  const [paidAt, setPaidAt] = useState<Date | null>(null);
  // Pagó con el NFC o el PIN y la respuesta no llegó: no se sabe si se cobró;
  // se sigue preguntando por el cobro y lo decide su estado (APP-02).
  const [checking, setChecking] = useState(false);
  // Con tarjeta, en la página de su banco (AUTHORIZING): cuándo salió el
  // intento según el servidor (el sondeo lo dice) y, mientras no llega, cuándo
  // se vio aquí. La espera del banco cuenta desde ahí (05-ui-ux §4.3).
  const [attemptIso, setAttemptIso] = useState<string | null>(null);
  const [authorizingSeenAt, setAuthorizingSeenAt] = useState<number | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const chargeId = cobro.saldo?.chargeId ?? null;
  const nfcOn = Boolean(chargeId) && methods.nfc && methods.wallet && nfcSupported();
  // ¿Se ve? Inicio sigue montado (oculto) al cambiar de pestaña.
  const [shownRef, shown] = useShown();

  const outcome = cobroOutcome({
    card: cobro.card ? { status: cardStatus, tipCents: cardTip } : null,
    saldo: saldo ?? (chargeId ? { status: 'PENDING', newBalanceCents: null } : null),
    localFail,
    canceledByMe,
  });
  const waiting = outcome.kind === 'waiting';

  // Tarjeta: tiempo real + sondeo de respaldo.
  const { reachable } = usePaymentLive(cobro.card, (update) => {
    setCardStatus((current) => advanceStatus(current, update.status));
    if (update.tipCents !== undefined) setCardTip(update.tipCents);
    if (update.attemptStartedAt) setAttemptIso(update.attemptStartedAt);
  });

  // Salió al banco: desde cuándo (aquí) mientras el sondeo no trae la hora del servidor.
  useEffect(() => {
    if (cardStatus === 'AUTHORIZING') setAuthorizingSeenAt((seen) => seen ?? Date.now());
    if (cardStatus !== 'AUTHORIZING') setConfirmingCancel(false);
  }, [cardStatus]);

  // Saldo: ¿lo pagó con su móvil (Face ID) o lo canceló la tarjeta? Al
  // momento por el tiempo real (wallet-charge:update) y, de respaldo, cada 10 s.
  const refreshSaldo = useWalletChargeLive(
    chargeId,
    async (signal) => {
      if (!chargeId) return 'stop';
      try {
        const fresh = await fetchSaldoState(chargeId, signal);
        setSaldo(fresh);
        if (fresh.status !== 'PENDING') return 'stop';
        if (checking) {
          // Sigue pendiente: aquel pago no llegó a cobrarse. Se vuelve a escuchar el NFC.
          setChecking(false);
          setToast(NOT_CHARGED_RETRY_TEXT);
        }
        return undefined;
      } catch {
        return signal.aborted ? 'stop' : 'slow';
      }
    },
    { slowIntervalMs: SALDO_POLL_SLOW_MS, enabled: Boolean(chargeId) && waiting },
  );

  // La tarjeta se canceló con el saldo pendiente: lo acaba de pagar el saldo.
  useEffect(() => {
    if (cardStatus === 'CANCELED' && chargeId) refreshSaldo();
  }, [cardStatus, chargeId, refreshSaldo]);

  // Pagado: una vez (refresca lo de la chica) y con su hora.
  useEffect(() => {
    if (outcome.kind !== 'paid' || paidAt) return;
    setPaidAt(new Date());
    onPaid();
  }, [outcome.kind, paidAt, onPaid]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  // Sin confirmar por el banco se sigue mirando (si lo aprueba, PAGADO): pantalla encendida.
  const watching = waiting || outcome.kind === 'unconfirmed';
  useWakeLock(watching);
  useOpenCharge('cobro', true, watching);
  // Arriba, solo «OxioPay no responde»: la espera del banco y el «sin confirmar»
  // los dice esta pantalla (su franja y «El banco no lo ha confirmado»); la
  // franja de arriba lo repetiría y taparía su título.
  useHealthReport(`cobro:${cobro.card?.id ?? chargeId ?? 'x'}`, watching ? { serverDown: !reachable } : {});

  /** El NFC acercado: pagado (hasta el tope sin PIN), su PIN o la razón del NO PAGADO. */
  const handleCard = useCallback(
    async (card: string, uid: string | null) => {
      if (!chargeId) return;
      try {
        const out = await payByNfc(chargeId, card, uid);
        if (out.kind === 'paid') {
          setSaldo(out.state);
          return;
        }
        const w = await lookupNfc(card, uid);
        if (w.pinLocked) {
          setLocalFail({ title: 'PIN bloqueado', sentence: 'Su PIN está bloqueado por fallos: avisa al encargado.' });
          return;
        }
        if (!w.hasPin) {
          setLocalFail({ title: 'Sin PIN', sentence: 'Este saldo aún no tiene PIN: que pague con el QR desde su móvil.' });
          return;
        }
        setPin({ card, uid, code: w.code, reason: out.reason === 'night_cap' || out.reason === 'no_uid' ? out.message : null });
      } catch (err) {
        await failFrom(err, card, uid);
      }
    },
    // failFrom solo usa setters y el total del cobro (no cambian).
    [chargeId],
  );

  async function failFrom(err: unknown, card: string, uid: string | null) {
    const kind = payFailureKind(err);
    if (kind === 'already_paid') {
      setToast('Ya está pagado');
      refreshSaldo();
      return;
    }
    if (kind === 'ambiguous') {
      // Sin respuesta o con el servidor caído: pudo cobrarse. Nada de «No se ha
      // cobrado»: se pregunta por el cobro (el sondeo sigue) y decide su estado.
      setChecking(true);
      setToast(CHECKING_TEXT);
      refreshSaldo();
      return;
    }
    const e = err instanceof CobroApiError ? err : null;
    let wallet: { code: string; balanceCents: number } | null = null;
    if (e?.code === 'WALLET_INSUFFICIENT') {
      wallet = await lookupNfc(card, uid)
        .then((w) => ({ code: w.code, balanceCents: w.balanceCents }))
        .catch(() => null);
    }
    setLocalFail(failReasonOf(e ?? { message: (err as Error).message }, { totalCents: cobro.totalCents, wallet }));
  }

  // El NFC, por detrás, mientras se espera (Android con Chrome). Mientras se
  // comprueba un pago sin respuesta, no se lee otro; con la pestaña oculta
  // (Recepción, Saldo…), tampoco: la ficha que acercan allí no paga este cobro.
  const listens = waitingListensNfc({ nfcOn, waiting, pinOpen: pin !== null, checking, shown });
  useEffect(() => {
    if (!listens) return undefined;
    const ctrl = new AbortController();
    void (async () => {
      try {
        const read = await readCard(ctrl.signal);
        if (ctrl.signal.aborted) return;
        if (!read.token) {
          setToast('Este NFC está vacío: se carga en recepción.');
          setNfcRound((n) => n + 1);
          return;
        }
        setReading(true);
        await handleCard(read.token, read.uid);
      } catch (err) {
        if ((err as Error).name === 'AbortError' || ctrl.signal.aborted) return;
        setToast((err as Error).message);
        setTimeout(() => setNfcRound((n) => n + 1), 1500);
      } finally {
        setReading(false);
      }
    })();
    return () => ctrl.abort();
  }, [listens, nfcRound, handleCard]);

  async function cancel() {
    setCanceling(true);
    try {
      if (cobro.card) await cancelCard(cobro.card.id);
      else if (chargeId) await cancelSaldo(chargeId);
      setCanceledByMe(true);
    } catch {
      // Ya no se podía cancelar: quizá lo acaba de pagar. Lo dice el estado.
      refreshSaldo();
      setToast(
        cardStatus === 'AUTHORIZING'
          ? 'No se puede cancelar mientras el cliente paga en su banco: espera su respuesta.'
          : 'No se ha podido cancelar: mira si ya está pagado.',
      );
    } finally {
      setCanceling(false);
      setConfirmingCancel(false);
    }
  }

  // Cancelado por quien cobra: vuelve a la carta.
  useEffect(() => {
    if (outcome.kind === 'canceled' && canceledByMe) onNew();
  }, [outcome.kind, canceledByMe, onNew]);

  const stripe = cobro.sections.map((s) => ({ color: colorOf(s.section), weight: s.cents }));
  const primarySection = [...cobro.sections].sort((a, b) => b.cents - a.cents)[0]?.section ?? null;
  const allSections = cobro.sections.map((s) => s.section);

  if (outcome.kind === 'paid') {
    // Con tarjeta, la «Comisión del servicio» del cobro (la dice el API al crearlo).
    const amounts = paidAmounts({ ...cobro, serviceFeeCents: cobro.card?.serviceFeeCents }, outcome);
    const tip = tipLine(amounts);
    const breakdown = paidBreakdown(amounts);
    // El mismo código que ve el cliente (el del cobro único, también si pagó con el saldo); sin cobro con tarjeta, ninguno.
    const code = cobro.card ? confirmationCode(cobro.card.id) : null;
    return (
      <StaffOutcome
        kind="paid"
        amountCents={amounts.totalCents}
        compactAmount
        section={primarySection}
        sections={allSections}
        sectionLabel={sectionLabel}
        reference={cobro.ref}
        stripe={stripe}
        code={code}
        codeHint="El mismo que ve el cliente"
        summary={
          breakdown ? (
            <p className={styles.left}>{breakdown}</p>
          ) : tip ? (
            <p className={styles.left}>
              {tip.base} + <b>{tip.tip}</b> de propina
            </p>
          ) : null
        }
        detail={
          <PaidDetail
            cobro={cobro}
            newBalanceCents={outcome.newBalanceCents}
            meta={paidMeta({ who: cobro.who, what: cobro.invitation ? null : cobro.what, method: outcome.method, at: paidAt ?? new Date() })}
          />
        }
        primary={{ label: 'Nuevo cobro', onClick: onNew }}
      />
    );
  }

  if (outcome.kind === 'unconfirmed' && cobro.card) {
    return <Unconfirmed cobro={cobro} paymentId={cobro.card.id} onLeave={onNew} />;
  }

  if (outcome.kind === 'failed') {
    const backToQr = outcome.qrStillOpen;
    return (
      <StaffOutcome
        kind="failed"
        amountCents={cobro.totalCents}
        compactAmount
        section={primarySection}
        sections={allSections}
        sectionLabel={sectionLabel}
        reference={null}
        stripe={stripe}
        message=""
        detail={
          <div className={styles.reason}>
            <b>{outcome.reason.title}</b>
            {outcome.reason.sentence}
          </div>
        }
        primary={
          backToQr
            ? {
                label: `Cobrar ${formatEur(cobro.totalCents, { compact: true })} con QR`,
                onClick: () => setLocalFail(null),
                icon: <IconQr />,
              }
            : { label: 'Otro QR · mismo importe', onClick: onRetry, loading: retrying }
        }
        secondary={{ label: 'Cancelar', onClick: backToQr ? () => void cancel() : onNew, disabled: retrying || canceling }}
        error={retryError}
      />
    );
  }

  if (outcome.kind === 'expired' || outcome.kind === 'canceled') {
    return (
      <StaffOutcome
        kind="expired"
        amountCents={cobro.totalCents}
        compactAmount
        section={primarySection}
        sections={allSections}
        sectionLabel={sectionLabel}
        stripe={stripe}
        message={outcome.kind === 'expired' ? 'El cliente no pagó a tiempo.' : 'El cobro se ha cancelado.'}
        primary={{ label: 'Otro QR · mismo importe', onClick: onRetry, loading: retrying }}
        secondary={{ label: 'Nuevo cobro', onClick: onNew, disabled: retrying }}
        error={retryError}
      />
    );
  }

  if (pin && chargeId) {
    return (
      <div className={styles.overlay}>
        <PinScreen
          colors={stripe}
          chip={cobro.pinChip}
          amountCents={cobro.totalCents}
          detail={`${cobro.what} · saldo ${pin.code}`}
          reason={pin.reason}
          onCancel={() => setPin(null)}
          onPin={async (value) => {
            try {
              const state = await payByPin(chargeId, pin.card, pin.uid, value);
              if (state.status === 'ACCEPTED') {
                setPin(null);
                setSaldo(state);
                return null;
              }
              return 'No se ha cobrado todavía: vuelve a intentarlo.';
            } catch (err) {
              const e = err instanceof CobroApiError ? err : null;
              // PIN malo (quedan intentos): se queda en el teclado con el aviso.
              if (e && e.status === 422 && !/bloquead/i.test(e.message)) return e.message;
              setPin(null);
              await failFrom(err, pin.card, pin.uid);
              return null;
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className={styles.overlay} data-charge-open="" ref={shownRef}>
      <Waiting
        cobro={cobro}
        nfcOn={nfcOn}
        reading={reading}
        checking={checking}
        toast={toast}
        bank={{ status: cobro.card ? cardStatus : null, attemptIso, seenAt: authorizingSeenAt }}
      >
        {confirmingCancel ? (
          <div className={styles.cancelAsk} role="alertdialog" aria-label={CANCEL_WHILE_PAYING_TEXT}>
            <p>{CANCEL_WHILE_PAYING_TEXT}</p>
            <button type="button" className={`${styles.btn} ${styles.ghost}`} onClick={() => setConfirmingCancel(false)} autoFocus>
              No, seguir esperando
            </button>
            <button type="button" className={`${styles.btn} ${styles.ghost}`} onClick={() => void cancel()} disabled={canceling}>
              {canceling ? 'Cancelando…' : 'Sí, cancelar'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={`${styles.btn} ${styles.ghost}`}
            // Con el cliente en la página de su banco, se confirma antes.
            onClick={() => (cardStatus === 'AUTHORIZING' ? setConfirmingCancel(true) : void cancel())}
            disabled={canceling}
          >
            {canceling ? 'Cancelando…' : 'Cancelar cobro'}
          </button>
        )}
      </Waiting>
    </div>
  );
}

/** La pantalla de espera (3.1 / 2.4). */
function Waiting({
  cobro,
  nfcOn,
  reading,
  checking,
  toast,
  bank,
  children,
}: {
  cobro: CobroAbierto;
  nfcOn: boolean;
  reading: boolean;
  /** Un pago con el NFC o el PIN se quedó sin respuesta: se comprueba si se cobró. */
  checking: boolean;
  toast: string | null;
  /** Con tarjeta: su estado y desde cuándo espera al banco (servidor o, si aún no lo dice, aquí). */
  bank?: { status: PaymentStatus | null; attemptIso: string | null; seenAt: number | null };
  children: ReactNode;
}) {
  const [receivedAt] = useState(() => Date.now());
  const deadline = useMemo(() => {
    const expires = cobro.card?.qrExpiresAt ?? cobro.saldo?.expiresAt;
    return expires ? qrDeadline(expires, receivedAt, cobro.card?.createdAt) : null;
  }, [cobro.card?.qrExpiresAt, cobro.card?.createdAt, cobro.saldo?.expiresAt, receivedAt]);
  const now = useNow(true);
  const night = useVenueNight();
  const left = deadline ? secondsLeft(deadline, now) : 0;
  const fraction = deadline ? remainingFraction(deadline, now) : 0;
  const phase = deadline ? countdownPhase(left) : 'ok';
  const ending = phase !== 'ok';
  const qr = cobro.card?.qrPngDataUrl ?? cobro.saldoQr ?? null;
  const colors = cobro.sections.slice(0, 2).map((s) => colorOf(s.section));
  const invite = Boolean(cobro.invitation);
  // El cliente en la página de su banco: la hora del servidor pasada al reloj
  // de este móvil con el plazo del QR (el mismo en los dos).
  const serverExpires = cobro.card?.qrExpiresAt ? Date.parse(cobro.card.qrExpiresAt) : Number.NaN;
  const anchor = deadline && Number.isFinite(serverExpires) ? { serverMs: serverExpires, localMs: deadline.endMs } : null;
  const attemptMs = bank?.attemptIso ? serverToLocalMs(Date.parse(bank.attemptIso), anchor) : (bank?.seenAt ?? null);
  const wait = cardWait({
    status: bank?.status ?? null,
    attemptStartedAtMs: Number.isFinite(attemptMs) ? attemptMs : null,
    qrExpiresAtMs: deadline?.endMs ?? null,
    nowMs: now,
  });
  const waitParts = checking ? null : cardWaitParts(wait);
  const slowBank = showsBankStrip(wait);

  return (
    <div className={styles.screen}>
      <div
        className={`${styles.band}${colors[1] ? ` ${styles.bandDuo}` : ''}`}
        style={{ '--c': colors[0] ?? 'var(--np-sec-otros)', '--c2': colors[1] } as CSSProperties}
      >
        <b>{cobro.band.title}</b>
        <span>{cobro.band.detail}</span>
      </div>
      <div className={styles.waitBody}>
        <p className={styles.amountXl}>{formatEur(cobro.totalCents, { compact: true })}</p>
        {/* Con la «Comisión del servicio»: con tarjeta paga más (con el saldo, no). */}
        {waitingFeeHint(cobro) ? <p className={styles.meta}>{waitingFeeHint(cobro)}</p> : null}
        {/* Viva: un punto que late y lo que pasa, también para el lector de pantalla (cambia solo al cambiar de fase). */}
        <p
          className={`${styles.live}${ending || slowBank ? ` ${styles.liveEnding}` : ''}`}
          role="status"
          aria-live="polite"
          data-bank-wait={wait.stage}
        >
          <i aria-hidden="true" />
          {waitParts ? (
            <>
              {waitParts.label}
              {/* El reloj, cada segundo, solo a la vista: el lector oye la fase. */}
              {waitParts.clock ? <span aria-hidden="true">{` ${waitParts.clock}`}</span> : null}
            </>
          ) : (
            waitingLiveText(phase, checking)
          )}
        </p>
        {slowBank ? (
          <p className={styles.bankStrip}>
            <b>{wait.stage === 'retry' ? 'El banco no ha contestado' : 'El banco está tardando'}</b>
            {wait.stage === 'retry'
              ? 'Si el cliente lo vuelve a intentar con el mismo QR, no cobres otra vez por tu lado.'
              : 'No cobres otra vez: espera su respuesta. Si se cobra, sale aquí.'}
          </p>
        ) : null}
        <h2 className={styles.waitTitle}>{nfcOn ? 'Acerca el NFC o escanea' : 'Escanea el QR con tu móvil'}</h2>
        <div className={styles.dual}>
          {qr ? (
            <div className={styles.opt}>
              <div className={`${styles.qr}${nfcOn ? '' : ` ${styles.qrSolo}`}`} style={{ opacity: left <= 0 ? 0.3 : 1 }}>
                <img src={qr} alt="QR del cobro: el cliente lo escanea con su móvil" />
              </div>
              {invite ? 'Tarjeta o QR' : 'Con tu móvil'}
            </div>
          ) : null}
          {nfcOn && qr ? (
            <span className={styles.orDot} aria-hidden="true">
              o
            </span>
          ) : null}
          {nfcOn ? (
            <div className={styles.opt}>
              <NfcCard reading={reading || checking} />
              {checking ? 'Comprobando…' : reading ? 'Leyendo…' : invite ? 'NFC, sin PIN' : 'Por detrás'}
            </div>
          ) : null}
        </div>
        {nfcOn && pinExpected(cobro.totalCents, night) ? (
          <p className={`${styles.warnline} ${styles.waitPin}`}>
            <IconLock />
            {pinWarning(night)}
          </p>
        ) : null}
        {deadline ? (
          <div className={`${styles.timer}${ending ? ` ${styles.timerEnding}` : ''}`}>
            <span className={styles.tbar}>
              <i style={{ transform: `scaleX(${fraction})` }} />
            </span>
            <span>{left > 0 ? `Caduca en ${formatClock(left)}` : 'Comprobando…'}</span>
          </div>
        ) : null}
        {toast ? (
          <p className={styles.toast} role="status">
            {toast}
          </p>
        ) : null}
      </div>
      <div className={`${styles.foot} ${styles.footFlat}`}>{children}</div>
    </div>
  );
}

/** PAGADO (3.3 / 2.5): lo que le queda, quién / qué / cómo, y el reparto si es una invitación. */
function PaidDetail({ cobro, newBalanceCents, meta }: { cobro: CobroAbierto; newBalanceCents: number | null; meta: string }) {
  return (
    <>
      {newBalanceCents !== null ? (
        <p className={styles.left}>
          Le quedan <b>{formatEur(newBalanceCents, { compact: true })}</b>
        </p>
      ) : null}
      {cobro.invitation ? (
        <>
          <p style={{ fontSize: '1.125rem' }}>Invitación · {cobro.invitation.chica}</p>
          <div className={`${styles.psplit} ${styles.outcomeSplit}`}>
            {cobro.invitation.cells.map((c) => (
              <span key={c.label}>
                <small>{c.label}</small>
                <b>{formatEur(c.cents, { compact: true })}</b>
              </span>
            ))}
          </div>
        </>
      ) : null}
      <p className={styles.meta}>{meta}</p>
    </>
  );
}

/**
 * El banco no contestó a tiempo (ORPHAN): pudo cobrarse. Pantalla ámbar con
 * la referencia (la corta y el pedido del banco, si lo hay) y «Avisar al
 * encargado» (la incidencia del cobro le llega ahora). Nunca «Otro QR»: si el
 * banco lo aprueba después, aquí sale PAGADO solo.
 */
function Unconfirmed({ cobro, paymentId, onLeave }: { cobro: CobroAbierto; paymentId: string; onLeave: () => void }) {
  const [ref, setRef] = useState<BankRef | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchBankRef(paymentId, ctrl.signal)
      .then(setRef)
      .catch(() => setRef({ ref: cobro.ref, order: null }));
    return () => ctrl.abort();
  }, [paymentId, cobro.ref]);

  async function notify(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setNotice(notifiedText(await notifyManager(paymentId)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const shortRef = ref?.ref ?? cobro.ref;
  return (
    <div className={styles.overlay} data-charge-open="">
      <div className={`${styles.screen} ${styles.unconfirmed}`} role="alert" aria-live="assertive">
        <div className={styles.unconfirmedBody}>
          <p className={styles.unconfirmedKicker}>Sin confirmar</p>
          <h2 className={styles.waitTitle}>{UNCONFIRMED_TITLE}</h2>
          <p className={styles.amountXl}>{formatEur(cobro.totalCents, { compact: true })}</p>
          <p className={styles.meta}>{UNCONFIRMED_SENTENCE}</p>
          <dl className={styles.unconfirmedRef}>
            {shortRef ? (
              <div>
                <dt>Cobro</dt>
                <dd>{shortRef}</dd>
              </div>
            ) : null}
            {ref?.order ? (
              <div>
                <dt>Ref. del banco</dt>
                <dd>{ref.order}</dd>
              </div>
            ) : null}
          </dl>
          {notice ? (
            <p className={styles.toast} role="status">
              {notice}
            </p>
          ) : null}
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className={`${styles.foot} ${styles.footFlat}`}>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={() => void notify()} disabled={busy} aria-busy={busy}>
            {busy ? 'Avisando…' : 'Avisar al encargado'}
          </button>
          <button type="button" className={`${styles.btn} ${styles.ghost}`} onClick={onLeave}>
            Salir sin cobrar otra vez
          </button>
        </div>
      </div>
    </div>
  );
}
