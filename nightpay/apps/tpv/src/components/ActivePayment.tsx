'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  AmountDisplay,
  Button,
  Card,
  FormError,
  PaymentOutcome,
  QrCountdown,
  cardHow,
  StatusPill,
  awaitingServerExpiry,
  encodeQr,
  paidTicket,
  payQrTicket,
  PrintButton,
  usePrintTicket,
  isPreCobro,
  outcomeKindOf,
  qrDeadline,
  qrSvgPath,
  useNow,
  useWakeLock,
  type PaymentStatus,
  type QrDeadline,
} from '@nightpay/ui';
import { chargeBreakdownText, confirmationCode, formatMoney } from '@nightpay/contracts';
import { cancelPayment, fetchPaymentStatus, type CreatedPayment } from '@/lib/api';
import styles from './active-payment.module.css';

/** Estados en los que el QR ya no se puede pagar: basta con "Nuevo cobro". */
export const FINISHED_STATUSES: ReadonlySet<PaymentStatus> = new Set<PaymentStatus>([
  'AUTHORIZED',
  'FAILED',
  'EXPIRED',
  'CANCELED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
]);

/** Pasado el plazo sin el «caducado» del servidor: se le pregunta cada tanto. */
const EXPIRY_CHECK_MS = 4_000;

interface Props {
  payment: CreatedPayment;
  /** El nombre del local, para el ticket impreso (null: sin él). */
  venueName?: string | null;
  status: PaymentStatus | null;
  /** Se llega al servidor (socket o sondeo). */
  reachable: boolean;
  /** Preguntar ya el estado al servidor. */
  checkNow: () => void;
  /** Vuelve al formulario para un cobro nuevo. */
  onDone: () => void;
  /** «Otro QR · mismo importe» (rechazado o caducado): otro cobro igual, sin teclear. */
  onRetry: () => void;
  retrying: boolean;
  retryError: string | null;
}

/**
 * El cobro en curso: QR con su cuenta atrás, importe y estado; al terminar,
 * el resultado a pantalla completa. Si aún se puede pagar, "Cancelar cobro"
 * lo anula en el API antes de volver al formulario: si no, el QR anterior
 * seguiría pagándose. Si no se puede anular, se dice y la cajera decide.
 * Mientras está abierto, la pantalla no se apaga. Nunca se da por caducado
 * sin que lo diga el servidor: un «pagado» perdido con la wifi haría cobrar
 * dos veces al cliente con «Otro QR».
 */
export function ActivePayment({ payment, venueName = null, status, reachable, checkNow, onDone, onRetry, retrying, retryError }: Props) {
  const [canceling, setCanceling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // El plazo cuenta desde que llegó la respuesta, con la duración que dio el servidor.
  const [receivedAt] = useState(() => Date.now());
  const deadline = useMemo(
    () => qrDeadline(payment.qrExpiresAt, receivedAt, payment.createdAt),
    [payment.qrExpiresAt, payment.createdAt, receivedAt],
  );
  const shown = status ?? 'CREATED';
  const now = useNow(isPreCobro(shown));
  // Plazo pasado aquí, pero el servidor aún no ha dicho «caducado»: se le pregunta.
  const awaiting = awaitingServerExpiry(shown, deadline, now);
  const finished = FINISHED_STATUSES.has(shown);
  useWakeLock(!finished);

  // Pagado: cómo pagó (tarjeta, Apple o Google Pay), solo si el banco lo dio. Una consulta, una vez.
  const [cardFacts, setCardFacts] = useState<{ payMethod?: 'card' | 'wallet' | 'bitcoin' }>({});
  const paid = shown === 'AUTHORIZED';
  const [paidAt, setPaidAt] = useState<Date | null>(null);
  useEffect(() => {
    if (!paid) return undefined;
    setPaidAt((at) => at ?? new Date());
    const ctrl = new AbortController();
    fetchPaymentStatus(payment.qrToken, ctrl.signal)
      .then((current) => setCardFacts({ payMethod: current.payMethod }))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [paid, payment.qrToken]);

  useEffect(() => {
    if (!awaiting) return undefined;
    checkNow();
    const timer = setInterval(checkNow, EXPIRY_CHECK_MS);
    return () => clearInterval(timer);
  }, [awaiting, checkNow]);

  async function cancel() {
    setCanceling(true);
    setCancelError(null);
    try {
      await cancelPayment(payment.id);
      onDone();
    } catch (err) {
      setCancelError((err as Error).message);
      setCanceling(false);
    }
  }

  // «Comisión del servicio»: el cliente paga el importe + ella (el banco cobra el total).
  const feeCents = Math.max(0, payment.serviceFeeCents ?? 0);
  const breakdown = feeCents > 0 ? chargeBreakdownText({ baseCents: payment.amountCents, feeCents, tipCents: 0 }) : null;
  const outcome = outcomeKindOf(shown);
  if (outcome) {
    // El TPV no sabe quién cobra: sale la hora, sin nombre.
    const how = outcome === 'paid' ? cardHow({ ...cardFacts, code: confirmationCode(payment.id), at: paidAt }) : null;
    return (
      <PaymentOutcome
        key={outcome}
        kind={outcome}
        amountCents={payment.amountCents + feeCents}
        currency={payment.currency}
        detail={breakdown ? <p style={hintStyle}>{breakdown}</p> : undefined}
        message={outcome === 'failed' ? 'Que el cliente pruebe con otra tarjeta.' : undefined}
        how={how}
        print={
          how
            ? paidTicket({
                venue: venueName,
                amountCents: payment.amountCents + feeCents,
                currency: payment.currency,
                how,
                breakdown,
                at: paidAt ?? new Date(),
              })
            : null
        }
        primary={
          outcome === 'paid'
            ? { label: 'Nuevo cobro', onClick: onDone }
            : { label: 'Otro QR · mismo importe', onClick: onRetry, loading: retrying }
        }
        secondary={outcome === 'paid' ? undefined : { label: 'Nuevo cobro', onClick: onDone, disabled: retrying }}
        error={outcome === 'paid' ? null : retryError}
      />
    );
  }

  return (
    <div className={styles.grid}>
      <QrCard
        payment={payment}
        venueName={venueName}
        amountCents={payment.amountCents + feeCents}
        deadline={isPreCobro(shown) ? deadline : null}
        now={now}
      />

      {/* En el móvil, el importe va arriba y «Cancelar cobro» en una barra fija abajo. */}
      <Card className={styles.amount} style={{ padding: CARD_PAD, textAlign: 'center' }} data-tour="tpv-importe">
        <p style={sectionLabel}>Importe</p>
        <AmountDisplay amountCents={payment.amountCents} currency={payment.currency} status={shown} />
        {breakdown ? (
          <p style={hintStyle}>
            Con tarjeta paga {formatMoney(payment.amountCents + feeCents, { compact: true, currency: payment.currency })} ({breakdown})
          </p>
        ) : null}
        <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'center' }} data-tour="tpv-estado">
          <StatusPill status={shown} />
        </div>
        {awaiting ? (
          <p role="status" style={awaitStyle}>
            {reachable
              ? 'El QR ha caducado. Confirmando con el servidor que no se pagó…'
              : 'Sin conexión con el servidor: no sabemos si el cliente pagó. No cobres otra vez hasta que se confirme.'}
          </p>
        ) : null}
        <div className={styles.actions} data-tour="tpv-cancelar">
          {awaiting ? (
            <Button variant="ghost" size="md" onClick={checkNow}>
              Comprobar ahora
            </Button>
          ) : null}
          {finished ? (
            <Button variant="ghost" size="md" onClick={onDone}>
              Nuevo cobro
            </Button>
          ) : (
            <Button variant="ghost" size="md" onClick={cancel} loading={canceling}>
              Cancelar cobro
            </Button>
          )}
          {cancelError && !finished ? (
            <>
              <FormError>{cancelError}</FormError>
              <Button variant="ghost" size="md" onClick={onDone}>
                Dejarlo y hacer otro cobro
              </Button>
              <p style={hintStyle}>
                {awaiting
                  ? 'Ojo: no sabemos si el cliente pagó ese QR. Mira su móvil antes de cobrar otra vez.'
                  : 'Ojo: ese QR se podrá pagar hasta que caduque.'}
              </p>
            </>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

type CopyState = 'idle' | 'copied' | 'failed';

interface QrCardProps {
  payment: CreatedPayment;
  venueName: string | null;
  /** Lo que paga con tarjeta (con la comisión del servicio): lo que sale en el ticket. */
  amountCents: number;
  deadline: QrDeadline | null;
  now: number;
}

function QrCard({ payment, venueName, amountCents, deadline, now }: QrCardProps) {
  const [copy, setCopy] = useState<CopyState>('idle');
  const printer = usePrintTicket();

  // El QR en papel: el cliente lo escanea del ticket y paga en su móvil.
  function printQr() {
    printer.print(
      payQrTicket({
        venue: venueName,
        amountCents,
        currency: payment.currency,
        qrUrl: payment.qrUrl,
        expiresAt: payment.qrExpiresAt ? new Date(payment.qrExpiresAt) : null,
        at: new Date(payment.createdAt),
      }),
    );
  }

  useEffect(() => {
    if (copy === 'idle') return;
    const timer = setTimeout(() => setCopy('idle'), 1500);
    return () => clearTimeout(timer);
  }, [copy]);

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(payment.qrUrl);
      setCopy('copied');
    } catch {
      // Sin permiso de portapapeles: la URL está a la vista para copiarla a mano.
      setCopy('failed');
    }
  }

  return (
    <Card style={{ padding: CARD_PAD }} data-tour="tpv-qr">
      <p style={sectionLabel}>QR del cobro</p>
      {/* Fondo blanco en los dos temas: el lector del móvil lo necesita para leer el QR. */}
      <div style={{ marginTop: '1rem' }}>
        <QrCountdown deadline={deadline} nowMs={now}>
          <div className={deadline ? 'np-breathe' : undefined} style={qrBox}>
            <QrImage url={payment.qrUrl} fallbackSrc={payment.qrPngDataUrl} />
          </div>
        </QrCountdown>
      </div>
      <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <p style={sectionLabel}>URL</p>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'stretch' }}>
          <code style={urlCode}>{payment.qrUrl}</code>
          <Button variant="ghost" size="md" onClick={copyUrl}>
            {copy === 'copied' ? '✓ Copiado' : copy === 'failed' ? 'Cópiala a mano' : 'Copiar'}
          </Button>
        </div>
        {deadline ? <PrintButton label="Imprimir QR" onClick={printQr} /> : null}
      </div>
      {printer.ticketNode}
    </Card>
  );
}

/** Margen blanco alrededor (la norma pide 4 módulos para que se lea bien). */
const QUIET_ZONE = 4;

/**
 * El QR del cobro en vector (nítido en cualquier pantalla), con el mismo
 * enlace que lleva el PNG del API; si no cupiera en un QR, ese PNG.
 */
function QrImage({ url, fallbackSrc }: { url: string; fallbackSrc: string }) {
  const qr = useMemo(() => encodeQr(url), [url]);
  if (!qr) return <img src={fallbackSrc} alt="QR del cobro" style={qrImg} />;
  const side = qr.size + QUIET_ZONE * 2;
  return (
    <svg role="img" aria-label="QR del cobro" viewBox={`0 0 ${side} ${side}`} shapeRendering="crispEdges" style={qrImg}>
      <rect width={side} height={side} fill="#ffffff" />
      <path d={qrSvgPath(qr, QUIET_ZONE)} fill="#0b0b0b" />
    </svg>
  );
}

// Relleno de las tarjetas: 16 en el móvil (el importe y «Cancelar cobro» suben), 32 en la tableta.
const CARD_PAD = 'clamp(1rem, 4vw, 2rem)';

// Etiquetas 14/500 en t2, sin mayúsculas ni espaciado (Grafito).
const sectionLabel: CSSProperties = {
  fontSize: 'var(--np-fs-14)',
  fontWeight: 500,
  color: 'var(--np-text-mute)',
  margin: 0,
};

// Blanco con un margen de 8 px y el QR de 240 px útiles (vector).
const qrBox: CSSProperties = {
  background: 'white',
  borderRadius: 'var(--np-r-md)',
  padding: '0.5rem',
  display: 'flex',
  justifyContent: 'center',
};

const qrImg: CSSProperties = { width: '100%', maxWidth: 240, height: 'auto', aspectRatio: '1', display: 'block' };

const urlCode: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  padding: '0 0.875rem',
  fontFamily: 'var(--np-font-mono)',
  fontSize: 'var(--np-t-label)',
  background: 'var(--np-bg)',
  color: 'var(--np-text-mute)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-sm)',
  overflowX: 'auto',
  whiteSpace: 'nowrap',
  height: '3rem',
  minWidth: 0,
};

const awaitStyle: CSSProperties = {
  margin: '1rem 0 0',
  fontSize: 'var(--np-fs-16)',
  color: 'var(--np-warning)',
};

const hintStyle: CSSProperties = {
  margin: '0.75rem 0 0',
  fontSize: 'var(--np-fs-14)',
  color: 'var(--np-text-mute)',
};
