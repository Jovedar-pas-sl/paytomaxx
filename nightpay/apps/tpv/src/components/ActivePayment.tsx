'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { AmountDisplay, Button, Card, StatusPill, type PaymentStatus } from '@nightpay/ui';
import { cancelPayment, type CreatedPayment } from '@/lib/api';

/** Estados en los que el QR ya no se puede pagar: basta con "Nuevo cobro". */
const FINISHED: ReadonlySet<PaymentStatus> = new Set<PaymentStatus>([
  'AUTHORIZED',
  'FAILED',
  'EXPIRED',
  'CANCELED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
]);

interface Props {
  payment: CreatedPayment;
  status: PaymentStatus | null;
  live: boolean | null;
  /** Vuelve al formulario para un cobro nuevo. */
  onDone: () => void;
}

/**
 * El cobro en curso: QR, importe y estado. Si aún se puede pagar, "Cancelar
 * cobro" lo anula en el API antes de volver al formulario: si no, el QR
 * anterior seguiría pagándose. Si no se puede anular, se dice y la cajera
 * decide.
 */
export function ActivePayment({ payment, status, live, onDone }: Props) {
  const current = status ?? 'CREATED';
  const finished = FINISHED.has(current);
  const [canceling, setCanceling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

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

  return (
    <div style={gridStyle}>
      <QrCard payment={payment} />

      <Card variant="glow" style={{ padding: '2rem', textAlign: 'center' }}>
        <p style={sectionLabel}>Importe</p>
        <AmountDisplay amountCents={payment.amountCents} currency={payment.currency} status={current} />
        <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'center' }}>
          <StatusPill status={current} />
        </div>
        {live === false && !finished ? (
          <p style={hintStyle}>Sin conexión en directo: el estado puede tardar en cambiar.</p>
        ) : null}
        <div style={actionsStyle}>
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
              <p style={hintStyle}>Ojo: ese QR se podrá pagar hasta que caduque.</p>
            </>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

type CopyState = 'idle' | 'copied' | 'failed';

function QrCard({ payment }: { payment: CreatedPayment }) {
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
      <div style={qrBox}>
        <img src={payment.qrPngDataUrl} alt="QR del cobro" style={qrImg} />
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
  fontSize: '0.7rem',
  fontWeight: 500,
  color: 'var(--np-text-dim)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  margin: 0,
};

const qrBox: CSSProperties = {
  marginTop: '1rem',
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
  fontSize: '0.75rem',
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

const errStyle: CSSProperties = {
  color: 'var(--np-danger)',
  margin: 0,
  fontSize: '0.875rem',
};

const hintStyle: CSSProperties = {
  margin: '0.75rem 0 0',
  fontSize: '0.8125rem',
  color: 'var(--np-text-dim)',
};
