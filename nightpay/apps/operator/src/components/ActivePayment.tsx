'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  Button,
  Card,
  FormError,
  Icon,
  QrCountdown,
  StatusPill,
  awaitingServerExpiry,
  isPreCobro,
  outcomeKindOf,
  qrDeadline,
  useNow,
  useWakeLock,
  type OutcomeAction,
  type OutcomeKind,
  type PaymentStatus,
} from '@nightpay/ui';
import { confirmationCode } from '@nightpay/contracts';
import { cancelPayment, type CreatedPayment } from '@/lib/api';
import { CancelCobroConfirm } from './CancelCobroConfirm';
import { useHealthReport } from '@/lib/connection-health';
import { formatEur } from '@/lib/money';
import { chargeWithFeeCents, paymentFeeLine, posChargeLine } from '@/lib/cobro-view';
import { useOpenCharge, type ChargeSpot } from '@/lib/open-charges';
import { advanceStatus, isFinalStatus, type BitcoinLive } from '@/lib/payment-status';
import { AT_BANK_PAYING_TEXT, AT_BANK_SLOW_TEXT, bankCancel, cancelableAtFrom, type BankCancel } from '@/lib/cancel-at-bank';
import { serverToLocalMs } from '@/lib/cobro-state';
import { NewWalletCard } from './NewWalletCard';
import { useVenueMethods } from '@/lib/venue-methods';
import { chargeSectionLabel, useMySections } from '@/lib/sections';
import { posWaitTexts } from '@/lib/servicio';
import { CobroQr } from './cobrar/CobroQr';
import { StaffOutcome } from './StaffOutcome';
import { usePaymentLive } from './use-payment-live';

interface Props {
  payment: CreatedPayment;
  /** Cobro con datáfono: el QR es para el camarero, no para el cliente. */
  isPos: boolean;
  /** El servicio de la carta que se cobra (null: importe tecleado). */
  label: string | null;
  /** Se ha pagado: refrescar el saldo. */
  onPaid: () => void;
  /** Volver al formulario (tras pagado, cancelado o caducado). */
  onClose: () => void;
  /** «Otro QR · mismo importe»: otro cobro igual, sin teclear nada (rechazado o caducado). */
  onRetry?: () => void;
  retrying?: boolean;
  retryError?: string | null;
  /** Dónde está abierto (si la sesión caduca, se vuelve a esa pestaña). Por defecto, Inicio. */
  spot?: ChargeSpot;
  /** Con datáfono, lo cobra quien lo abrió (el encargado), no un camarero al que se llama. */
  byStaff?: boolean;
}

/**
 * El cobro recién creado: su QR con la cuenta atrás, su estado en tiempo real
 * (con sondeo de respaldo) y, al terminar, el resultado a pantalla completa.
 * Sigue vivo aunque la chica cambie de pestaña; mientras está abierto, la
 * pantalla no se apaga.
 */
export function ActivePayment({
  payment,
  isPos,
  label,
  onPaid,
  onClose,
  onRetry,
  retrying = false,
  retryError = null,
  spot = 'cobro',
  byStaff = false,
}: Props) {
  const [status, setStatus] = useState<PaymentStatus>(payment.status as PaymentStatus);
  // Fase 1B — propina que eligió el cliente en su página de pago.
  const [tipCents, setTipCents] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  // «¿Cancelar este cobro?»: siempre se confirma antes de cancelar.
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [paidSeen, setPaidSeen] = useState(false);
  // Recarga de saldo pagada: tras el «PAGADO», su código y su PIN.
  const [outcomeDismissed, setOutcomeDismissed] = useState(false);
  // El plazo cuenta desde que llegó la respuesta, con la duración que dio el servidor.
  const [receivedAt] = useState(() => Date.now());
  const deadline = useMemo(
    () => qrDeadline(payment.qrExpiresAt, receivedAt, payment.createdAt),
    [payment.qrExpiresAt, payment.createdAt, receivedAt],
  );
  const [authorizingSince, setAuthorizingSince] = useState<number | null>(null);
  // En su banco: cuándo salió el intento (la hora del servidor, del sondeo) y si paga con bitcoin
  // (undefined: el sondeo aún no lo ha dicho; null: en su banco).
  const [attemptIso, setAttemptIso] = useState<string | null>(null);
  const [bitcoin, setBitcoin] = useState<BitcoinLive | null | undefined>(undefined);

  const { reachable } = usePaymentLive(payment, (update) => {
    setStatus((current) => advanceStatus(current, update.status));
    if (update.tipCents !== undefined) setTipCents(update.tipCents);
    if (update.status === 'AUTHORIZED') setPaidSeen(true);
    if (update.attemptStartedAt) setAttemptIso(update.attemptStartedAt);
    if (update.bitcoin !== undefined) setBitcoin(update.bitcoin);
  });

  // Pagado (por el socket o por el sondeo, lo que llegue antes): una vez.
  useEffect(() => {
    if (paidSeen) onPaid();
    // Solo al pasar a pagado.
  }, [paidSeen]);

  useEffect(() => {
    if (status === 'AUTHORIZING') setAuthorizingSince((since) => since ?? Date.now());
  }, [status]);

  // Mientras se puede pagar, la cuenta atrás; en su banco, los 2 minutos antes de poder cancelar (un solo reloj).
  const now = useNow(isPreCobro(status) || status === 'AUTHORIZING');
  // Nunca se da por caducado sin el servidor: un «pagado» perdido con la wifi
  // haría cobrar dos veces con «Otro QR». Pasado el plazo, se espera su respuesta.
  const shown = status;
  const awaiting = awaitingServerExpiry(status, deadline, now);
  const open = !isFinalStatus(shown);
  useWakeLock(open);
  const { sections } = useMySections();
  // En pantalla (esperando o con su resultado): si la sesión caduca, se entra encima sin perderlo.
  useOpenCharge(spot, true, open);
  useHealthReport(
    `cobro:${payment.id}`,
    open
      ? {
          serverDown: !reachable,
          bankWaitingSinceMs: status === 'AUTHORIZING' ? authorizingSince : null,
          orphan: status === 'ORPHAN',
        }
      : {},
  );

  async function cancel() {
    setCanceling(true);
    setError(null);
    try {
      await cancelPayment(payment.id);
      setConfirming(false);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setCanceling(false);
      setConfirming(false);
    }
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(payment.qrUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* sin portapapeles: el QR sigue en pantalla */
    }
  }

  const outcome = outcomeKindOf(shown);
  const refLine = [payment.ref, chargeSectionLabel(payment.lines, sections)].filter(Boolean).join(' · ') || null;
  if (outcome && !(outcome === 'paid' && outcomeDismissed)) {
    return (
      <StaffOutcome
        key={outcome}
        kind={outcome}
        // Con datáfono, lo que se cobró en él: el importe + la comisión del servicio.
        amountCents={isPos ? chargeWithFeeCents(payment) : payment.amountCents}
        currency={payment.currency}
        message={outcome === 'failed' && !isPos ? 'Que el cliente pruebe con otra tarjeta.' : undefined}
        detail={
          <OutcomeDetail
            label={label}
            tipCents={outcome === 'paid' ? tipCents : 0}
            feeCents={outcome === 'paid' ? (payment.serviceFeeCents ?? 0) : 0}
            refLine={outcome === 'paid' ? refLine : null}
          />
        }
        // El cliente ve el mismo código en su móvil; con datáfono no hay móvil que comparar.
        code={outcome === 'paid' && !isPos ? confirmationCode(payment.id) : null}
        codeHint="Debe coincidir con el del móvil del cliente."
        {...outcomeActions(outcome, {
          isPos,
          hasWallet: Boolean(payment.walletId),
          onClose,
          onRetry,
          retrying,
          onShowWallet: () => setOutcomeDismissed(true),
        })}
        error={outcome === 'paid' ? null : retryError}
      />
    );
  }

  // POS_EXTERNAL: el QR no es para el cliente, es para que el camarero vea
  // el cobro pendiente. Mostramos código corto humano-legible.
  const refCode = payment.id.slice(-6).toUpperCase();
  const posTexts = posWaitTexts(byStaff);
  const preCobro = isPreCobro(shown);
  const bank = shown === 'AUTHORIZING' ? atBankCancel({ bitcoin, attemptIso, seenAt: authorizingSince, payment, deadline, nowMs: now }) : 'free';

  return (
    // data-charge-open: en Inicio del móvil, lo de arriba se aparta mientras está el QR (home.module.css).
    // Tarjeta neutra (Grafito): la lima, solo en el botón de la pantalla.
    <Card data-charge-open="" style={{ padding: 'var(--np-pad-card)', display: 'flex', flexDirection: 'column', gap: 'var(--np-gap)' }}>
      <div style={{ textAlign: 'center' }}>
        <p style={kicker}>{isPos ? 'Cobro POS' : 'Importe'}</p>
        <p className="np-num" style={amountBig}>
          {/* Con datáfono, en grande lo que se cobra en él (con la comisión del servicio). */}
          {formatEur(isPos ? chargeWithFeeCents(payment) : payment.amountCents)}
        </p>
        {label ? <p style={{ margin: '0.25rem 0 0', fontWeight: 500, fontSize: 'var(--np-fs-16)' }}>{label}</p> : null}
        {/* Con la «Comisión del servicio»: lo que paga con tarjeta (o, en una recarga, lo que se cobra). */}
        {!isPos && paymentFeeLine(payment) ? <p style={{ ...hintStyle, margin: '0.25rem 0 0' }}>{paymentFeeLine(payment)}</p> : null}
        {isPos && payment.serviceFeeCents ? (
          <p style={{ ...hintStyle, margin: '0.25rem 0 0' }}>
            {posChargeLine({ amountCents: chargeWithFeeCents(payment), baseAmountCents: payment.amountCents, serviceFeeCents: payment.serviceFeeCents })}
          </p>
        ) : null}
        {isPos ? (
          <p style={{ margin: '0.5rem 0 0', fontSize: 'var(--np-fs-14)', color: 'var(--np-text-mute)' }}>
            {posTexts.codeLead} <strong style={refCodeStyle}>#{refCode}</strong>
          </p>
        ) : null}
      </div>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <StatusPill status={shown} />
      </div>
      {awaiting ? (
        <p role="status" style={{ margin: 0, textAlign: 'center', fontSize: 'var(--np-fs-14)', color: 'var(--np-warning)' }}>
          {reachable
            ? 'El QR ha caducado. Confirmando con el servidor que no se pagó…'
            : 'Sin conexión con el servidor: no sabemos si el cliente pagó. No cobres otra vez hasta que se confirme.'}
        </p>
      ) : null}

      <QrCountdown deadline={preCobro ? deadline : null} nowMs={now}>
        <div style={qrBoxStyle}>
          {/* En vector, con su enlace (el PNG del API, solo si no se pudiera dibujar).
              --np-qr: 20rem; en el móvil, según el alto (el QR y sus botones en una pantalla). */}
          <div style={{ width: '100%', maxWidth: isPos ? 'min(12rem, var(--np-qr))' : 'var(--np-qr)' }}>
            <CobroQr value={payment.qrUrl} fallbackPng={payment.qrPngDataUrl} label={isPos ? 'QR del cobro POS' : 'QR del cobro'} quiet={3} />
          </div>
        </div>
      </QrCountdown>
      {isPos ? (
        <div style={posNoteStyle}>
          <p style={{ margin: 0, fontSize: 'var(--np-fs-14)', lineHeight: 1.6 }}>
            {posTexts.callWaiter ? (
              <>
                <strong>Camarero:</strong> escanea el QR con tu móvil (o usa código <strong style={refCodeStyle}>#{refCode}</strong>).
                <br />
              </>
            ) : null}
            Cobra <strong>{formatEur(chargeWithFeeCents(payment))}</strong> en el datáfono
            {payment.serviceFeeCents ? ' (con la comisión del servicio)' : ''}
            {posTexts.after}
          </p>
        </div>
      ) : (
        <Button onClick={() => void copyUrl()} variant="ghost" size="md">
          {copied ? <><Icon name="check" size={20} className="np-icon-lead" />Copiado</> : 'Copiar link del cobro'}
        </Button>
      )}

      {shown === 'AUTHORIZED' ? (
        <PaidBlock payment={payment} tipCents={tipCents} onNew={onClose} />
      ) : preCobro || shown === 'AUTHORIZING' ? (
        // Sin pagar: pide confirmar. Con el cliente en su banco, los primeros 2 minutos sin botón; después, con el aviso.
        <>
          {bank === 'wait' || bank === 'late' ? (
            <p role="status" style={{ margin: 0, textAlign: 'center', fontSize: 'var(--np-fs-14)', color: 'var(--np-text-mute)' }}>
              {bank === 'wait' ? AT_BANK_PAYING_TEXT : AT_BANK_SLOW_TEXT}
            </p>
          ) : null}
          {bank === 'free' || bank === 'late' ? (
            <Button onClick={() => setConfirming(true)} variant="danger" size="md" loading={canceling}>
              Cancelar cobro
            </Button>
          ) : null}
        </>
      ) : (
        <Button onClick={onClose} variant="ghost" size="md">
          Nuevo cobro
        </Button>
      )}

      {error ? <FormError>{error}</FormError> : null}
      <CancelCobroConfirm
        open={confirming}
        atBank={bank === 'late'}
        busy={canceling}
        onConfirm={() => void cancel()}
        onClose={() => setConfirming(false)}
      />
    </Card>
  );
}

/**
 * «Cancelar cobro» con el cobro en AUTHORIZING: con la factura de bitcoin, como
 * siempre; en su banco, los 2 minutos desde que salió el intento (la hora del
 * servidor pasada a este móvil con el plazo del QR; mientras el sondeo no la
 * trae, desde que se vio aquí). null: aún no se sabe si es banco o bitcoin.
 */
function atBankCancel(i: {
  bitcoin: BitcoinLive | null | undefined;
  attemptIso: string | null;
  seenAt: number | null;
  payment: Pick<CreatedPayment, 'qrExpiresAt'>;
  deadline: { endMs: number } | null;
  nowMs: number;
}): BankCancel | null {
  if (i.bitcoin === undefined) return null;
  if (i.bitcoin !== null && i.bitcoin !== 'unknown') return 'free';
  const serverExpires = Date.parse(i.payment.qrExpiresAt);
  const anchor = i.deadline && Number.isFinite(serverExpires) ? { serverMs: serverExpires, localMs: i.deadline.endMs } : null;
  const since = i.attemptIso ? serverToLocalMs(Date.parse(i.attemptIso), anchor) : i.seenAt;
  return bankCancel(true, cancelableAtFrom(since), i.nowMs);
}

interface ActionContext {
  isPos: boolean;
  hasWallet: boolean;
  onClose: () => void;
  onRetry?: () => void;
  retrying: boolean;
  onShowWallet: () => void;
}

/** Los botones del resultado: seguir cobrando, o repetir el mismo cobro si no salió. */
function outcomeActions(
  kind: OutcomeKind,
  { isPos, hasWallet, onClose, onRetry, retrying, onShowWallet }: ActionContext,
): { primary: OutcomeAction; secondary?: OutcomeAction } {
  if (kind === 'paid') {
    // Recarga de saldo: falta darle su código (y su PIN o su ficha).
    return hasWallet
      ? { primary: { label: 'Seguir: código del saldo', onClick: onShowWallet } }
      : { primary: { label: 'Nuevo cobro', onClick: onClose } };
  }
  if (!onRetry) return { primary: { label: 'Nuevo cobro', onClick: onClose } };
  return {
    primary: {
      label: isPos ? 'Otro cobro · mismo importe' : 'Otro QR · mismo importe',
      onClick: onRetry,
      loading: retrying,
    },
    secondary: { label: 'Nuevo cobro', onClick: onClose, disabled: retrying },
  };
}

function OutcomeDetail({
  label,
  tipCents,
  feeCents = 0,
  refLine,
}: {
  label: string | null;
  tipCents: number;
  /** La «Comisión del servicio» que pagó encima (con tarjeta). */
  feeCents?: number;
  refLine: string | null;
}) {
  if (!label && tipCents <= 0 && feeCents <= 0 && !refLine) return null;
  return (
    <>
      {/* «C-0042 · Copas»: la referencia que ve el cliente en sus movimientos. */}
      {refLine ? (
        <p className="np-num" style={{ fontWeight: 600, letterSpacing: '0.04em' }}>
          {refLine}
        </p>
      ) : null}
      {label ? <p>{label}</p> : null}
      {feeCents > 0 ? <p className="np-num">+ {formatEur(feeCents, { compact: true })} comisión del servicio</p> : null}
      {tipCents > 0 ? <p className="np-num">+ {formatEur(tipCents, { compact: true })} de propina</p> : null}
    </>
  );
}

function PaidBlock({ payment, tipCents, onNew }: { payment: CreatedPayment; tipCents: number; onNew: () => void }) {
  // Ficha NFC apagada por el dueño: no se ofrece darla al recargar (el código y el PIN, siempre).
  const methods = useVenueMethods();
  return (
    <>
      <p style={{ ...kicker, textAlign: 'center' }}>
        Código de confirmación{' '}
        <strong className="np-num" style={{ fontSize: 'var(--np-fs-22)', color: 'var(--np-text)', letterSpacing: '0.2em' }}>
          {confirmationCode(payment.id)}
        </strong>
      </p>
      <p style={{ ...hintStyle, textAlign: 'center' }}>Debe coincidir con el del móvil del cliente.</p>
      {payment.walletId ? <NewWalletCard walletId={payment.walletId} withCard={methods.nfc} /> : null}
      {payment.serviceFeeCents ? (
        <p className="np-num" style={tipStyle}>
          + {formatEur(payment.serviceFeeCents, { compact: true })} comisión del servicio
        </p>
      ) : null}
      {tipCents > 0 ? (
        <p className="np-num" style={tipStyle}>
          + {formatEur(tipCents, { compact: true })} de propina
        </p>
      ) : null}
      <Button onClick={onNew} size="lg">
        <Icon name="check" size={20} className="np-icon-lead" />
        Pagado — nuevo
      </Button>
    </>
  );
}

// Grafito: sin mayúsculas ni espaciado (salvo los códigos), 14/500.
const kicker: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-label)',
  color: 'var(--np-text-label)',
  fontWeight: 500,
};

// Importe grande y suelto: 40/600 en cifras proporcionales.
const amountBig: CSSProperties = {
  margin: '0.25rem 0 0',
  fontSize: 'var(--np-fs-40)',
  lineHeight: 1.15,
  fontWeight: 600,
  fontVariantNumeric: 'proportional-nums',
};

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-fs-14)',
  color: 'var(--np-text-mute)',
  lineHeight: 1.4,
};

const refCodeStyle: CSSProperties = {
  fontFamily: 'var(--np-font-mono)',
  fontWeight: 600,
  letterSpacing: '0.15em',
  color: 'var(--np-text)',
};

const qrBoxStyle: CSSProperties = {
  background: 'white',
  borderRadius: 'var(--np-r-md)',
  padding: '0.75rem',
  display: 'flex',
  justifyContent: 'center',
};

const posNoteStyle: CSSProperties = {
  padding: '1rem',
  background: 'var(--np-surface-2)',
  borderRadius: 'var(--np-r-md)',
  border: '1px solid var(--np-border)',
  textAlign: 'center',
};

// Sin lima: la lima es del botón «Cobrado — nuevo».
const tipStyle: CSSProperties = {
  margin: 0,
  textAlign: 'center',
  fontWeight: 600,
  fontSize: 'var(--np-fs-18)',
  color: 'var(--np-text)',
};
