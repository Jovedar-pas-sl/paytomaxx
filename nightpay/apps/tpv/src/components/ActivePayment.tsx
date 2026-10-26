'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  AmountDisplay,
  Button,
  Card,
  PaymentOutcome,
  QrCountdown,
  StatusPill,
  awaitingServerExpiry,
  isPreCobro,
  outcomeKindOf,
  qrDeadline,
  useNow,
  useWakeLock,
  type PaymentStatus,
  type QrDeadline,
} from '@nightpay/ui';
import { chargeBreakdownText, confirmationCode, formatMoney } from '@nightpay/contracts';
import { cancelPayment, type CreatedPayment } from '@/lib/api';

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
export function ActivePayment({ payment, status, reachable, checkNow, onDone, onRetry, retrying, retryError }: Props) {
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
    return (
      <PaymentOutcome
        key={outcome}
        kind={outcome}
        amountCents={payment.amountCents + feeCents}
        currency={payment.currency}
        detail={breakdown ? <p style={hintStyle}>{breakdown}</p> : undefined}
        message={outcome === 'failed' ? 'Que el cliente pruebe con otra tarjeta.' : undefined}
        code={outcome === 'paid' ? confirmationCode(payment.id) : null}
        codeHint="Debe coincidir con el del móvil del cliente."
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
    <div style={gridStyle}>
      <QrCard payment={payment} deadline={isPreCobro(shown) ? deadline : null} now={now} />

      <Card variant="glow" style={{ padding: '2rem', textAlign: 'center' }}>
        <p style={sectionLabel}>Importe</p>
        <AmountDisplay amountCents={payment.amountCents} currency={payment.currency} status={shown} />
        {breakdown ? (
          <p style={hintStyle}>
            Con tarjeta paga {formatMoney(payment.amountCents + feeCents, { compact: true, currency: payment.currency })} ({breakdown})
          </p>
        ) : null}
        <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'center' }}>
          <StatusPill status={shown} />
        </div>
        {awaiting ? (
          <p role="status" style={awaitStyle}>
            {reachable
              ? 'El QR ha caducado. Confirmando con el servidor que no se pagó…'
              : 'Sin conexión con el servidor: no sabemos si el cliente pagó. No cobres otra vez hasta que se confirme.'}
          </p>
        ) : null}
        <div style={actionsStyle}>
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
              <p role="alert" style={errStyle}>
                {cancelError}
              </p>
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

function QrCard({ payment, deadline, now }: { payment: CreatedPayment; deadline: QrDeadline | null; now: number }) {
  const [copy, setCopy] = useState<CopyState>('idle');

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
    <Card style={{ padding: '2rem' }}>
      <p style={sectionLabel}>QR del cobro</p>
      {/* Fondo blanco en los dos temas: el lector del móvil lo necesita para leer el QR. */}
      <div style={{ marginTop: '1rem' }}>
        <QrCountdown deadline={deadline} nowMs={now}>
          <div style={qrBox}>
            <img src={payment.qrPngDataUrl} alt="QR del cobro" style={qrImg} />
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
      </div>
    </Card>
  );
}

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 20rem), 1fr))',
  gap: '2rem',
  alignItems: 'start',
};

const sectionLabel: CSSProperties = {
  fontSize: 'var(--np-t-label)',
  fontWeight: 600,
  color: 'var(--np-text-label)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  margin: 0,
};

const qrBox: CSSProperties = {
  background: 'white',
  borderRadius: 'var(--np-r-md)',
  padding: '1rem',
  display: 'flex',
  justifyContent: 'center',
};

const qrImg: CSSProperties = { width: '100%', maxWidth: 320, height: 'auto', display: 'block' };

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
  borderRadius: 'var(--np-r-md)',
  overflowX: 'auto',
  whiteSpace: 'nowrap',
  height: '3rem',
  minWidth: 0,
};

const actionsStyle: CSSProperties = {
  marginTop: '2rem',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '0.75rem',
};

const awaitStyle: CSSProperties = {
  margin: '1rem 0 0',
  fontSize: '0.9375rem',
  color: 'var(--np-warning)',
};

const errStyle: CSSProperties = {
  color: 'var(--np-danger)',
  margin: 0,
  fontSize: '0.875rem',
};

const hintStyle: CSSProperties = {
  margin: '0.75rem 0 0',
  fontSize: '0.875rem',
  color: 'var(--np-text-mute)',
};
