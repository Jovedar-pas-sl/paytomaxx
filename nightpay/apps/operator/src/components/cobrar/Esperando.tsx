'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { confirmationCode, type BitcoinPayState, type PaymentStatus } from '@nightpay/contracts';
import { cardHow, countdownPhase, formatClock, qrDeadline, saldoHow, secondsLeft, useNow, useWakeLock, ScreenHelp } from '@nightpay/ui';
import { fetchPaymentStatus, getUser } from '@/lib/api';
import { clearFichaContext, saveFichaContext } from '@/lib/ficha-context';
import { formatEur } from '@/lib/money';
import { nfcSupported, readCard, waitingListensNfc } from '@/lib/nfc';
import { useHealthReport } from '@/lib/connection-health';
import { useOpenCharge } from '@/lib/open-charges';
import { cardFactsOf, type PaidCardFacts } from '@/lib/payment-status';
import { fichaContextOf, iphoneFichaHint, pinDetail, showsSinMovil, SIN_MOVIL_LABEL, type PinVia } from '@/lib/sin-movil';
import { useVenueMethods, useVenueNight } from '@/lib/venue-methods';
import { useWalletChargeLive } from '../use-wallet-charge-live';
import {
  CobroApiError,
  cancelCard,
  cancelSaldo,
  fetchSaldoState,
  lookupCode,
  lookupNfc,
  payByNfc,
  payByPin,
  payFailureKind,
  type CobroCreado,
  type SaldoRef,
  type SaldoState,
} from '@/lib/api-cobro';
import {
  CHECKING_TEXT,
  NO_PIN_SENTENCE,
  NO_PIN_TITLE,
  NOT_CHARGED_RETRY_TEXT,
  failReasonOf,
  paidAmounts,
  paidBreakdown,
  pinExpected,
  pinWarning,
  tipLine,
  waitingFeeHint,
  waitingLiveText,
  type FailReason,
} from '@/lib/cobro-view';
import {
  BITCOIN_CONFIRMING_CODE,
  LEAVE_WITHOUT_CHARGING,
  UNCONFIRMED_SENTENCE,
  UNCONFIRMED_TITLE,
  bitcoinWaitText,
  cancelFailedText,
  cancelOffer,
  cardAfter,
  cardWait,
  cardWaitParts,
  cobroOutcome,
  payingWithBitcoin,
  serverToLocalMs,
  showsBankStrip,
  type CardLive,
} from '@/lib/cobro-state';
import { fetchBankRef, notifiedText, notifyManager, type BankRef } from '@/lib/api-bank-wait';
import { useShown } from '../reception/desk/use-shown';
import { StaffOutcome } from '../StaffOutcome';
import { useCustomerDisplay } from '../use-customer-display';
import { usePaymentLive } from '../use-payment-live';
import { colorOf } from './cobrar-context';
import { CobroQr } from './CobroQr';
import { IconLock, IconNfc, IconQr } from './icons';
import { PinScreen } from './PinScreen';
import { pinTipSetup, withScreenTip } from '@/lib/pin-tip';
import { WAIT_TITLE_EN } from '@/lib/pin-pad';
import { TOURS } from '@/lib/tours';
import { ScreenHeader } from './ScreenHeader';
import { SinMovil, type SaldoForPin } from './SinMovil';
import styles from './cobrar.module.css';

/** Lo que hay que enseñar de un cobro abierto (lo pone quien lo crea). */
export interface CobroAbierto {
  /** El cobro con tarjeta (su QR abre la página de pago). Null: el local cobra solo con saldo. */
  card: CobroCreado | null;
  /** El cobro del saldo (el enlazado o el suelto): lo pagan el NFC y su PIN. */
  saldo: { chargeId: string; expiresAt: string } | null;
  /** El QR del cobro del saldo suelto (sin tarjeta): el PNG del API, por si su enlace no se pudiera dibujar. */
  saldoQr?: string | null;
  /** El enlace de pago del cobro del saldo suelto: su QR se dibuja aquí, en vector. */
  saldoUrl?: string | null;
  /** Lo que paga el cliente (en un cobro de antes, con la propina que puso el personal). */
  totalCents: number;
  /** La propina que puso el personal en un cobro de antes (va dentro de totalCents). B1: en los nuevos, nunca. */
  tipCents?: number;
  /** El cliente puede dejar propina al pagar con su PIN (propinas del local y del puesto encendidas). Sin el dato: no. */
  tipsOn?: boolean;
  ref: string | null;
  /** Secciones del cobro con su importe: el chip del resultado y del PIN. */
  sections: ReadonlyArray<{ section: string; cents: number }>;
  /** La cabecera de Esperando: «Copas» · «2 copas · Carlos» (o «Invitación» · «Nerea · Carlos»). */
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

/** El PIN que se pide: de qué saldo (su ficha, su código o su pase), cómo se dice y por qué lo pide. */
type PinStep = SaldoForPin & { reason: string | null };

/**
 * Esperando (maqueta 3.1): el importe, el QR y el NFC a la vez, sin elegir
 * nada. El QR abre la página de pago (tarjeta, o «Pagar con mi saldo») y el
 * NFC acercado por detrás paga el cobro del saldo enlazado; gana el primero.
 * El PIN, solo si el API lo pide (3.2). El resultado a pantalla completa:
 * PAGADO (3.3) o NO PAGADO con la razón y una salida (3.4). Pantalla siempre
 * encendida. En iPhone (sin NFC en la web) la ficha la lee el propio iPhone:
 * abre su enlace en otra pestaña, que paga este cobro con su PIN (el contexto
 * de ficha que se guarda aquí mientras se espera). Lo raro, discreto: «Sin
 * móvil ni ficha» (su código o su pase, y su PIN aquí). Es la única pantalla
 * de cobrar: la pestaña «Saldo» ya no existe.
 */
export function Esperando({ cobro, onNew, onRetry, retrying = false, retryError = null, onPaid, sectionLabel }: Props) {
  const methods = useVenueMethods();
  // B1: la propina la elige el cliente en la pantalla del PIN (sin nada marcado).
  const basePinTip = pinTipSetup({
    totalCents: cobro.totalCents,
    tipCents: cobro.tipCents,
    tipsOn: methods.tips && cobro.tipsOn === true,
    flatCents: methods.tipFlatCents,
    percents: methods.tipPercents,
  });
  // El cobro con tarjeta (el QR): su estado y, si el cliente paga con bitcoin, el de su factura.
  const [card, setCard] = useState<CardLive>(() => ({ status: (cobro.card?.status as PaymentStatus) ?? 'CREATED', bitcoin: null }));
  const cardStatus = card.status;
  // La propina del cliente con tarjeta: undefined hasta que la diga el API (no es 0).
  const [cardTip, setCardTip] = useState<number | undefined>(undefined);
  // Pagado con tarjeta: lo que el banco dio de cómo (4 últimas cifras, Apple o Google Pay).
  const [cardFacts, setCardFacts] = useState<PaidCardFacts>({});
  // Pagado con ficha: su número impreso (la respuesta del pago con ficha lo trae; el sondeo, no).
  const [fichaNo, setFichaNo] = useState<string | null>(null);
  // Pagado con su PIN aquí: con qué se identificó el saldo (la ficha, su código o su pase). El sondeo no lo dice.
  const [paidVia, setPaidVia] = useState<PinVia | null>(null);
  const [saldo, setSaldo] = useState<SaldoState | null>(null);
  // La propina que el cliente ya eligió en la pantalla de la barra (va en el cobro del saldo): marcada en el PIN.
  const pinTip = withScreenTip(basePinTip, saldo?.status === 'PENDING' ? (saldo.tipCents ?? 0) : 0);
  const [localFail, setLocalFail] = useState<FailReason | null>(null);
  const [canceledByMe, setCanceledByMe] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [pin, setPin] = useState<PinStep | null>(null);
  // «Sin móvil ni ficha»: su código o su pase (lo que antes solo tenía «Saldo»).
  const [sinMovil, setSinMovil] = useState(false);
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

  const chargeId = cobro.saldo?.chargeId ?? null;
  const nfcOn = Boolean(chargeId) && methods.nfc && methods.wallet && nfcSupported();
  // Su código o su pase, con su PIN aquí: con el cobro del saldo y el saldo encendido.
  const sinMovilOn = showsSinMovil({ chargeId, wallet: methods.wallet });
  // En iPhone la app no lee la ficha: el iPhone abre su enlace y esa pestaña paga este cobro.
  const fichaHint = iphoneFichaHint({ chargeId, venueNfc: methods.nfc && methods.wallet, webNfc: nfcSupported() });
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
    setCard((current) => cardAfter(current, update));
    if (update.tipCents !== undefined) setCardTip(update.tipCents);
    if (update.payMethod) {
      setCardFacts((facts) => ({
        ...facts,
        ...(update.payMethod ? { payMethod: update.payMethod } : {}),
      }));
    }
    if (update.attemptStartedAt) setAttemptIso(update.attemptStartedAt);
  });

  // Salió al banco: desde cuándo (aquí) mientras el sondeo no trae la hora del servidor.
  useEffect(() => {
    if (cardStatus === 'AUTHORIZING') setAuthorizingSeenAt((seen) => seen ?? Date.now());
  }, [cardStatus]);

  // Saldo: ¿lo pagó con su móvil (Face ID) o lo canceló la tarjeta? Al
  // momento por el tiempo real (wallet-charge:update) y, de respaldo, cada 10 s.
  const refreshSaldo = useWalletChargeLive(
    chargeId,
    async (signal) => {
      if (!chargeId) return 'stop';
      try {
        const fresh = await fetchSaldoState(chargeId, signal);
        setSaldo((prev) => keepFicha(fresh, prev));
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

  // Pagó la tarjeta y el aviso en directo no trae cómo: una consulta más al sondeo, una vez.
  const cardToken = cobro.card?.qrToken ?? null;
  const cardPaid = outcome.kind === 'paid' && outcome.method === 'card';
  useEffect(() => {
    if (!cardPaid || !cardToken || cardFacts.payMethod) return undefined;
    const ctrl = new AbortController();
    fetchPaymentStatus(cardToken, ctrl.signal)
      .then((current) => setCardFacts((facts) => ({ ...facts, ...cardFactsOf(current) })))
      .catch(() => undefined);
    return () => ctrl.abort();
    // Una vez por cobro pagado.
  }, [cardPaid, cardToken]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  // Sin confirmar por el banco se sigue mirando (si lo aprueba, PAGADO): pantalla encendida.
  const watching = waiting || outcome.kind === 'unconfirmed';
  useWakeLock(watching);
  // La «Pantalla del cliente» de la barra (si hay una emparejada): este importe y este QR.
  useCustomerDisplay({ paymentId: cobro.card?.id ?? null, chargeId });
  useOpenCharge('cobro', true, watching);
  // Arriba, solo «OxioPay no responde»: la espera del banco y el «sin confirmar»
  // los dice esta pantalla (su franja y «El banco no lo ha confirmado»); la
  // franja de arriba lo repetiría y taparía su título.
  useHealthReport(`cobro:${cobro.card?.id ?? chargeId ?? 'x'}`, watching ? { serverDown: !reachable } : {});

  // La ficha en un iPhone (?ficha=…) y el pase leído con la cámara del móvil
  // (?pase=…) abren la app en otra pestaña: pagan ESTE cobro con su PIN
  // mientras se espera y se ve (oculto, como el NFC: no paga lo que se acerca en otra pantalla).
  const userId = getUser()?.id ?? null;
  const saldoExpiresAt = cobro.saldo?.expiresAt ?? null;
  useEffect(() => {
    if (!userId || !chargeId || !saldoExpiresAt || !methods.wallet || !waiting || !shown) return undefined;
    saveFichaContext(fichaContextOf({ userId, chargeId, totalCents: cobro.totalCents, what: cobro.what, expiresAt: saldoExpiresAt }));
    return () => clearFichaContext((ctx) => ctx.kind === 'cobro' && ctx.chargeId === chargeId);
  }, [userId, chargeId, saldoExpiresAt, methods.wallet, waiting, shown, cobro.totalCents, cobro.what]);

  /** El NFC acercado: pagado (hasta el tope sin PIN), su PIN o la razón del NO PAGADO. */
  const handleCard = useCallback(
    async (card: string, uid: string | null) => {
      if (!chargeId) return;
      try {
        const out = await payByNfc(chargeId, card, uid);
        if (out.kind === 'paid') {
          if (out.state.fichaNumber) setFichaNo(out.state.fichaNumber);
          setPaidVia('nfc');
          setSaldo(out.state);
          return;
        }
        const w = await lookupNfc(card, uid);
        if (w.pinLocked) {
          setLocalFail({ title: 'PIN bloqueado', sentence: 'Su PIN está bloqueado por fallos: avisa al encargado.' });
          return;
        }
        if (!w.hasPin) {
          setLocalFail({ title: NO_PIN_TITLE, sentence: NO_PIN_SENTENCE });
          return;
        }
        const reason = out.reason === 'night_cap' || out.reason === 'no_uid' ? out.message : null;
        // La propina que el cliente eligió en la pantalla de la barra (si la hay): marcada en el PIN.
        const fresh = await fetchSaldoState(chargeId).catch(() => null);
        if (fresh) setSaldo((prev) => keepFicha(fresh, prev));
        setPin({ ref: { card, uid }, walletCode: w.code, via: 'nfc', reason });
      } catch (err) {
        await failFrom(err, { card, uid });
      }
    },
    // failFrom solo usa setters y el total del cobro (no cambian).
    [chargeId],
  );

  /** «No le llega»: lo que tiene, por su ficha o su código (su pase no lo enseña). */
  async function walletOf(ref: SaldoRef): Promise<{ code: string; balanceCents: number } | null> {
    try {
      const w = 'card' in ref ? await lookupNfc(ref.card, ref.uid) : 'code' in ref ? await lookupCode(ref.code) : null;
      return w ? { code: w.code, balanceCents: w.balanceCents } : null;
    } catch {
      return null;
    }
  }

  async function failFrom(err: unknown, ref: SaldoRef) {
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
    const wallet = e?.code === 'WALLET_INSUFFICIENT' ? await walletOf(ref) : null;
    setLocalFail(failReasonOf(e ?? { message: (err as Error).message }, { totalCents: cobro.totalCents, wallet }));
  }

  // El NFC, por detrás, mientras se espera (Android con Chrome). Mientras se
  // comprueba un pago sin respuesta, no se lee otro; con la pestaña oculta
  // (Recepción, Cobros…), tampoco: la ficha que acercan allí no paga este
  // cobro. Con «Sin móvil ni ficha» delante, tampoco (está tecleando su código).
  const listens = waitingListensNfc({ nfcOn, waiting, pinOpen: pin !== null || sinMovil, checking, shown });
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
    } catch (err) {
      // Ya no se podía cancelar: quizá lo acaba de pagar (con bitcoin, o ya está en la red). Lo dice el estado.
      refreshSaldo();
      const code = err instanceof CobroApiError ? err.code : null;
      if (code === BITCOIN_CONFIRMING_CODE) setCard((current) => cardAfter(current, { status: current.status, bitcoin: 'confirming' }));
      setToast(cancelFailedText(card, code));
    } finally {
      setCanceling(false);
    }
  }

  // Cancelado por quien cobra: vuelve a la carta.
  useEffect(() => {
    if (outcome.kind === 'canceled' && canceledByMe) onNew();
  }, [outcome.kind, canceledByMe, onNew]);

  // «Cancelar cobro»: con el cliente en su banco no se puede; con bitcoin, mientras la factura espera el pago, sí.
  const offer = cancelOffer(card);

  // Las secciones con su color: el punto del chip del PIN.
  const pinColors = cobro.sections.map((s) => ({ color: colorOf(s.section), weight: s.cents }));
  const primarySection = [...cobro.sections].sort((a, b) => b.cents - a.cents)[0]?.section ?? null;
  const allSections = cobro.sections.map((s) => s.section);

  if (outcome.kind === 'paid') {
    // Con tarjeta, la «Comisión del servicio» del cobro (la dice el API al crearlo).
    const amounts = paidAmounts({ ...cobro, serviceFeeCents: cobro.card?.serviceFeeCents }, outcome);
    const tip = tipLine(amounts);
    const breakdown = paidBreakdown(amounts);
    // El mismo código que ve el cliente (el del cobro único, también si pagó con el saldo); sin cobro con tarjeta, ninguno.
    const code = cobro.card ? confirmationCode(cobro.card.id) : null;
    const at = paidAt ?? new Date();
    // Cómo pagó: con tarjeta, lo que dio el banco; con el saldo, la ficha o el móvil. Solo datos del API.
    const how =
      outcome.method === 'card'
        ? cardHow({ ...cardFacts, code, who: cobro.who, at })
        : saldoHow({
            fichaNumber: fichaNo,
            codeHint: saldo?.walletCodeHint ?? null,
            paidWith: outcome.method,
            paidVia,
            code,
            newBalanceCents: outcome.newBalanceCents,
            who: cobro.who,
            at,
          });
    return (
      <StaffOutcome
        kind="paid"
        amountCents={amounts.totalCents}
        compactAmount
        section={primarySection}
        sections={allSections}
        sectionLabel={sectionLabel}
        reference={cobro.ref}
        how={how}
        summary={
          breakdown ? (
            <p className={styles.left}>{breakdown}</p>
          ) : tip ? (
            <p className={styles.left}>
              {tip.base} + <b>{tip.tip}</b> de propina
            </p>
          ) : null
        }
        detail={<PaidDetail cobro={cobro} what={cobro.invitation ? null : cobro.what} />}
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
          colors={pinColors}
          chip={cobro.pinChip}
          amountCents={cobro.totalCents}
          tipSetup={pinTip}
          detail={pinDetail(cobro.what, pin.walletCode, pin.via)}
          reason={pin.reason}
          onCancel={() => setPin(null)}
          onPin={async (value, tipCents) => {
            try {
              // B1: con la propina que eligió el cliente en esta pantalla.
              const state = await payByPin(chargeId, pin.ref, value, tipCents);
              if (state.status === 'ACCEPTED') {
                setPin(null);
                setPaidVia(pin.via);
                if (state.fichaNumber) setFichaNo(state.fichaNumber);
                setSaldo(state);
                return null;
              }
              return 'No se ha cobrado todavía: vuelve a intentarlo.';
            } catch (err) {
              const e = err instanceof CobroApiError ? err : null;
              // PIN malo (quedan intentos): se queda en el teclado con el aviso.
              if (e && e.status === 422 && !/bloquead/i.test(e.message)) return e.message;
              setPin(null);
              await failFrom(err, pin.ref);
              return null;
            }
          }}
        />
      </div>
    );
  }

  if (sinMovil && chargeId) {
    return (
      <div className={styles.overlay} data-charge-open="">
        <SinMovil
          chargeId={chargeId}
          amountCents={cobro.totalCents}
          what={cobro.what}
          onReady={(found) => {
            setSinMovil(false);
            setPin({ ...found, reason: null });
          }}
          onBack={() => setSinMovil(false)}
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
        bank={{ status: cobro.card ? cardStatus : null, attemptIso, seenAt: authorizingSeenAt, bitcoin: cobro.card ? payingWithBitcoin(card) : null }}
        fichaHint={fichaHint}
        onSinMovil={sinMovilOn && !checking ? () => setSinMovil(true) : undefined}
      >
        {offer.kind !== 'button' ? (
          // Con el cliente en la página de su banco el API no deja cancelar (lo resuelve el banco:
          // PAGADO, fallido o sin confirmar), así que no se ofrece un botón que siempre fallaría.
          // Con bitcoin, tampoco con el pago ya en la red; mientras la factura espera el pago, sí.
          <>
            <p className={styles.altHint}>{offer.text}</p>
            {offer.kind === 'leave' ? (
              // Bitcoin en la red o con un problema: se puede salir sin cancelar (sigue en «Cobros»).
              <button type="button" className={`${styles.btn} ${styles.ghost} ${styles.cancelLink}`} onClick={onNew}>
                {LEAVE_WITHOUT_CHARGING}
              </button>
            ) : null}
          </>
        ) : (
          <button type="button" className={`${styles.btn} ${styles.ghost} ${styles.cancelLink}`} onClick={() => void cancel()} disabled={canceling}>
            {canceling ? 'Cancelando…' : 'Cancelar cobro'}
          </button>
        )}
      </Waiting>
    </div>
  );
}

/** La propina que marcó el personal (va dentro del total): «33 € + 5 € de propina», a la vista del cliente (PS-A1). */
function staffTipOf(cobro: CobroAbierto): { base: string; tip: string } | null {
  const tip = cobro.tipCents ?? 0;
  return tipLine({ baseCents: cobro.totalCents - tip, tipCents: tip, totalCents: cobro.totalCents });
}

/**
 * La pantalla de espera (3.1 / 2.4), en Grafito: la cabecera dice de qué es el
 * cobro; debajo, el importe, el QR de 240 px en vector, las dos formas en una
 * línea (la ficha con su icono, sin tarjeta dibujada) y una sola señal de
 * espera: el punto, lo que pasa y el reloj, en una línea.
 */
function Waiting({
  cobro,
  nfcOn,
  reading,
  checking,
  toast,
  bank,
  fichaHint = null,
  onSinMovil,
  children,
}: {
  cobro: CobroAbierto;
  nfcOn: boolean;
  reading: boolean;
  /** Un pago con el NFC o el PIN se quedó sin respuesta: se comprueba si se cobró. */
  checking: boolean;
  toast: string | null;
  /**
   * Con tarjeta: su estado y desde cuándo espera al banco (servidor o, si aún no
   * lo dice, aquí). Con bitcoin, el estado de su factura (sin banco ni sus fases).
   */
  bank?: { status: PaymentStatus | null; attemptIso: string | null; seenAt: number | null; bitcoin?: Exclude<BitcoinPayState, 'closed'> | null };
  /** iPhone: cómo se paga con la ficha (la app no la lee; el iPhone abre su enlace). */
  fichaHint?: string | null;
  /** «Sin móvil ni ficha»: su código o su pase y su PIN aquí. Sin él, no se ofrece. */
  onSinMovil?: () => void;
  children: ReactNode;
}) {
  const staffTip = staffTipOf(cobro);
  const [receivedAt] = useState(() => Date.now());
  const deadline = useMemo(() => {
    const expires = cobro.card?.qrExpiresAt ?? cobro.saldo?.expiresAt;
    return expires ? qrDeadline(expires, receivedAt, cobro.card?.createdAt) : null;
  }, [cobro.card?.qrExpiresAt, cobro.card?.createdAt, cobro.saldo?.expiresAt, receivedAt]);
  const now = useNow(true);
  const night = useVenueNight();
  const left = deadline ? secondsLeft(deadline, now) : 0;
  const phase = deadline ? countdownPhase(left) : 'ok';
  // Pagando con bitcoin: ni las fases del banco ni el reloj del QR (la factura tiene su plazo).
  const bitcoin = bank?.status === 'AUTHORIZING' ? (bank.bitcoin ?? null) : null;
  const ending = !bitcoin && phase !== 'ok';
  // El QR se dibuja aquí con su enlace de pago; el PNG del API, solo si no hay enlace.
  const qrUrl = cobro.card?.qrUrl ?? cobro.saldoUrl ?? null;
  const qrPng = cobro.card?.qrPngDataUrl ?? cobro.saldoQr ?? null;
  const hasQr = Boolean(qrUrl || qrPng);
  const invite = Boolean(cobro.invitation);
  // El cliente en la página de su banco: la hora del servidor pasada al reloj
  // de este móvil con el plazo del QR (el mismo en los dos).
  const serverExpires = cobro.card?.qrExpiresAt ? Date.parse(cobro.card.qrExpiresAt) : Number.NaN;
  const anchor = deadline && Number.isFinite(serverExpires) ? { serverMs: serverExpires, localMs: deadline.endMs } : null;
  const attemptMs = bank?.attemptIso ? serverToLocalMs(Date.parse(bank.attemptIso), anchor) : (bank?.seenAt ?? null);
  const wait = cardWait({
    status: bitcoin ? null : (bank?.status ?? null),
    attemptStartedAtMs: Number.isFinite(attemptMs) ? attemptMs : null,
    qrExpiresAtMs: deadline?.endMs ?? null,
    nowMs: now,
  });
  const waitParts = checking ? null : cardWaitParts(wait);
  const slowBank = showsBankStrip(wait);
  // Un solo reloj en la línea: el de la espera del banco si lo lleva; si no (también con el banco
  // tardando o en reintento), lo que le queda al QR. Con bitcoin, ninguno.
  const expiry = deadline && left > 0 ? `Caduca en ${formatClock(left)}` : null;
  const clock = bitcoin ? null : (waitParts?.clock ?? expiry);
  const liveText = bitcoin && !checking ? bitcoinWaitText(bitcoin) : waitParts ? waitParts.label : waitingLiveText(phase, checking);

  return (
    <div className={styles.screen}>
      <ScreenHeader title={cobro.band.title} subtitle={cobro.band.detail} help={<ScreenHelp {...TOURS.esperando} ready={false} />} />
      <div className={styles.waitBody}>
        <p className={styles.amountXl} data-tour="esperando-importe">{formatEur(cobro.totalCents, { compact: true })}</p>
        {/* La propina que marcó el personal, a la vista del cliente antes de pagar (PS-A1), como en el PAGADO. */}
        {staffTip ? (
          <p className={styles.meta}>
            {staffTip.base} + {staffTip.tip} de propina
          </p>
        ) : null}
        {/* Con la «Comisión del servicio»: con tarjeta paga más (con el saldo, no). */}
        {waitingFeeHint(cobro) ? <p className={styles.meta}>{waitingFeeHint(cobro)}</p> : null}
        {nfcOn && pinExpected(cobro.totalCents, night) ? (
          <p className={`${styles.warnline} ${styles.waitPin}`}>
            <IconLock />
            {pinWarning(night)}
          </p>
        ) : null}
        <h2 className={styles.waitTitle}>{nfcOn ? 'Acerca el NFC o escanea' : 'Escanea el QR con tu móvil'}</h2>
        {/* Lo lee el cliente: su línea en inglés (PS-A10). */}
        <p lang="en" className={styles.waitEn}>
          {nfcOn ? WAIT_TITLE_EN.nfc : WAIT_TITLE_EN.qr}
        </p>
        {hasQr ? (
          <div className={left > 0 ? `${styles.qr} np-breathe` : styles.qr} style={{ opacity: left <= 0 ? 0.3 : 1 }} data-tour="esperando-qr">
            <CobroQr value={qrUrl} fallbackPng={qrPng} quiet={2} label="QR del cobro: el cliente lo escanea con su móvil" />
          </div>
        ) : null}
        {hasQr || nfcOn ? (
          <p className={styles.ways} data-tour="esperando-formas">
            {/* Invitación: «Tarjeta, QR o ficha, sin PIN» (sin ficha, «Tarjeta o QR»; sin QR, «Ficha, sin PIN»). */}
            {hasQr ? <span>{invite ? (nfcOn ? 'Tarjeta, QR' : 'Tarjeta o QR') : 'Con tu móvil'}</span> : null}
            {hasQr && nfcOn ? <span aria-hidden="true">o</span> : null}
            {nfcOn ? (
              <span className={`${styles.nfcWay}${reading || checking ? ` ${styles.nfcReading}` : ''}`}>
                <IconNfc />
                {checking ? 'Comprobando…' : reading ? 'Leyendo…' : invite ? (hasQr ? 'ficha, sin PIN' : 'Ficha, sin PIN') : 'Por detrás'}
              </span>
            ) : null}
          </p>
        ) : null}
        <p className={`${styles.live}${ending || slowBank ? ` ${styles.liveEnding}` : ''}`} data-tour="esperando-estado">
          {/* Viva: un punto que late y lo que pasa, también para el lector de pantalla (cambia solo al cambiar de fase). */}
          <span className={styles.liveNow} role="status" aria-live="polite" data-bank-wait={wait.stage}>
            <i aria-hidden="true" />
            {liveText}
          </span>
          {/* El reloj, fuera de la región viva: se lee al pasar por él, sin anunciarse cada segundo. */}
          {clock ? <span className={styles.clock}>{clock}</span> : null}
        </p>
        {slowBank ? (
          <p className={styles.bankStrip}>
            <b>{wait.stage === 'retry' ? 'El banco no ha contestado' : 'El banco está tardando'}</b>
            {wait.stage === 'retry'
              ? 'Si el cliente lo vuelve a intentar con el mismo QR, no cobres otra vez por tu lado.'
              : 'No cobres otra vez: espera su respuesta. Si se cobra, sale aquí.'}
          </p>
        ) : null}
        {fichaHint ? <p className={styles.altHint}>{fichaHint}</p> : null}
        {toast ? (
          <p className={styles.toast} role="status">
            {toast}
          </p>
        ) : null}
      </div>
      <div className={`${styles.foot} ${styles.footFlat}`}>
        {/* Lo raro (antes, solo en «Saldo»): sin móvil ni ficha, su código o su pase y su PIN aquí.
            En el pie, encima de «Cancelar cobro»: entero a la vista también en un móvil bajo
            (360 × 640), donde debajo del QR quedaba tapado por el propio pie. */}
        {onSinMovil ? (
          <button type="button" className={styles.altLink} onClick={onSinMovil} data-tour="esperando-sinmovil">
            {SIN_MOVIL_LABEL}
          </button>
        ) : null}
        <div className={styles.footCancel} data-tour="esperando-cancelar">
          {children}
        </div>
      </div>
    </div>
  );
}

/** PAGADO (3.3 / 2.5): lo que le queda, quién / qué / cómo, y el reparto si es una invitación. */
function PaidDetail({ cobro, what }: { cobro: CobroAbierto; what: string | null }) {
  return (
    <>
      {cobro.invitation ? (
        <>
          <p className={styles.left}>Invitación · {cobro.invitation.chica}</p>
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
      {what ? <p className="np-outcome-what">{what}</p> : null}
    </>
  );
}

/** El sondeo no trae la ficha (solo la respuesta del pago con ficha): se conserva. */
function keepFicha(fresh: SaldoState, prev: SaldoState | null): SaldoState {
  return fresh.fichaNumber || !prev?.fichaNumber ? fresh : { ...fresh, fichaNumber: prev.fichaNumber };
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
