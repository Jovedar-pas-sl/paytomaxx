'use client';

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input } from '@nightpay/ui';
import { staffTokenFrom } from '@nightpay/contracts';
import { formatEur } from '@/lib/money';
import { onInviteArrived, takePendingInvite } from '@/lib/invite-link';
import { QrScanner, qrScanSupported } from './QrScanner';

/**
 * «Copa con invitación» (cobro del saldo): antes de cobrar, el QR de la chica
 * invitada («Mi QR» en su app). Con la cámara de la app (Android), con la del
 * móvil (abre la app en otra pestaña y llega aquí solo) o pegando su enlace.
 */
export function InviteStep({
  name,
  priceCents,
  onToken,
  onCancel,
}: {
  name: string;
  priceCents: number;
  onToken: (token: string) => void;
  onCancel: () => void;
}) {
  const [scanning, setScanning] = useState(qrScanSupported());
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Leído hace un momento con la cámara del móvil (otra pestaña).
    const pending = takePendingInvite();
    if (pending) onToken(pending);
    return onInviteArrived(onToken);
  }, [onToken]);

  const scanned = useCallback(
    (text: string) => {
      const token = staffTokenFrom(text);
      if (token) onToken(token);
      else setError('Ese QR no es el de una chica. Que abra «Mi QR» en su app.');
    },
    [onToken],
  );
  const scanError = useCallback((message: string) => {
    setScanning(false);
    setError(message);
  }, []);

  function usePasted(e: FormEvent) {
    e.preventDefault();
    const token = staffTokenFrom(pasted);
    if (token) onToken(token);
    else setError('Ese enlace no es el QR de una chica.');
  }

  return (
    <Card style={cardStyle}>
      <p style={kicker}>Invitación</p>
      <p style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800 }}>
        {name} · <span className="np-num">{formatEur(priceCents, { compact: true })}</span>
      </p>
      <p style={hint}>Escanea el QR de la chica a la que invita (en su app, «Mi QR»).</p>
      {scanning ? <QrScanner onScan={scanned} onError={scanError} /> : (
        <p style={hint}>Abre la cámara del móvil y apunta a su QR: la invitación llega aquí sola.</p>
      )}
      <form onSubmit={usePasted} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
        <Input label="O pega su enlace" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="https://…?invita=…" />
        <Button type="submit" variant="ghost" disabled={!pasted.trim()}>
          Usar
        </Button>
      </form>
      {error ? (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      ) : null}
      <Button type="button" variant="ghost" onClick={onCancel}>
        Volver a la carta
      </Button>
    </Card>
  );
}

const cardStyle: CSSProperties = { padding: 'var(--np-pad-card)', display: 'flex', flexDirection: 'column', gap: 'var(--np-gap)' };
const kicker: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-label)',
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--np-text-label)',
};
const hint: CSSProperties = { margin: 0, fontSize: '0.9375rem', color: 'var(--np-text-mute)' };
const errorStyle: CSSProperties = { margin: 0, color: 'var(--np-danger)', fontWeight: 600 };
