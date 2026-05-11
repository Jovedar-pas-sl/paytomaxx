'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { io, type Socket } from 'socket.io-client';
import { Button, Card, Input, StatusPill, type PaymentStatus } from '@nightpay/ui';
import {
  fetchTerminals,
  initializeSoftPos,
  wsBase,
  type InitializedSoftPos,
} from '@/lib/api';

interface Props {
  onAuthorized: () => void;
}

/**
 * Phase 1C — Tap-to-Phone / SoftPOS.
 *
 * En v1 (sin Capacitor + Viva SDK nativo aún integrado), esta pantalla:
 *  1. Llama al backend para crear el Payment + Viva order.
 *  2. Muestra el orderCode + instrucciones para que la chica pase la tarjeta
 *     del cliente usando la app oficial Viva en su móvil (que ya tiene el
 *     SoftPOS certificado).
 *  3. Cuando llega webhook → WS event "payment:completed" → cierra pantalla.
 *
 * Cuando se añada Capacitor + Viva SDK móvil, este componente cambiará a
 * activar el NFC reader directamente sin app externa.
 */
export function ChargeContactless({ onAuthorized }: Props) {
  const [terminals, setTerminals] = useState<Array<{ externalId: string; label: string }>>([]);
  const [amount, setAmount] = useState('');
  const [active, setActive] = useState<InitializedSoftPos | null>(null);
  const [status, setStatus] = useState<PaymentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchTerminals()
      .then(setTerminals)
      .catch((err) => setError((err as Error).message));
  }, []);

  // Subscribe a updates por WS
  useEffect(() => {
    if (!active) return;
    const socket: Socket = io(`${wsBase}/rt`, { transports: ['websocket', 'polling'] });
    socket.on('connect', () => {
      socket.emit('payment:subscribe', { paymentId: active.paymentId });
    });
    socket.on('payment:update', (e: { paymentId: string; status: PaymentStatus }) => {
      if (e.paymentId === active.paymentId) setStatus(e.status);
    });
    socket.on(
      'payment:completed',
      (e: { paymentId: string; status: 'AUTHORIZED' | 'FAILED' | 'EXPIRED' | 'CANCELED' }) => {
        if (e.paymentId === active.paymentId) {
          setStatus(e.status);
          if (e.status === 'AUTHORIZED') onAuthorized();
        }
      },
    );
    return () => {
      socket.disconnect();
    };
  }, [active, onAuthorized]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (terminals.length === 0) {
      setError('No hay terminales configurados en el local');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if ('vibrate' in navigator) navigator.vibrate(10);
      const cents = Math.round(parseFloat(amount.replace(',', '.')) * 100);
      if (!Number.isFinite(cents) || cents <= 0) throw new Error('Importe inválido');
      const result = await initializeSoftPos({
        amountCents: cents,
        terminalExternalId: terminals[0]!.externalId,
      });
      setActive(result);
      setStatus('CREATED');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setActive(null);
    setStatus(null);
    setAmount('');
    setError(null);
  }

  async function copyOrderCode() {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(active.providerOrderCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  if (active) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <Card variant="glow" style={cardStyle}>
          <p style={labelText}>Cobro contactless preparado</p>
          <p className="np-num" style={amountText}>
            {(Math.round(parseFloat(amount.replace(',', '.')) * 100) / 100).toFixed(2)} €
          </p>
          {status ? (
            <div style={{ marginTop: '0.75rem' }}>
              <StatusPill status={status} size="md" />
            </div>
          ) : null}
        </Card>

        <Card style={instructionCard}>
          <h3 style={instructionTitle}>📲 Cómo cobrar (v1 sin SDK integrado)</h3>
          <ol style={instructionList}>
            <li>Abre la app oficial <strong>Viva.com SoftPOS</strong> en este móvil.</li>
            <li>Introduce el <strong>orderCode</strong> de abajo o escanea el QR de la transacción.</li>
            <li>Acerca la tarjeta del cliente al dorso del móvil.</li>
            <li>El estado se actualizará aquí automáticamente cuando autorice.</li>
          </ol>
          <div style={orderCodeBox}>
            <code style={orderCodeText}>{active.providerOrderCode}</code>
            <Button variant="ghost" size="sm" onClick={copyOrderCode}>
              {copied ? '✓ Copiado' : 'Copiar'}
            </Button>
          </div>
          <p style={envHint}>
            Entorno: <strong>{active.environment}</strong>
          </p>
        </Card>

        <Button variant="ghost" onClick={reset}>
          Cancelar y volver
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <h2 style={titleStyle}>Cobrar contactless</h2>
      <p style={subText}>
        El cliente acerca su tarjeta / Apple Pay / Google Pay al móvil. Sin escanear QR.
      </p>
      <Input
        label="Importe (€)"
        type="text"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        required
        size="lg"
        autoFocus
        style={{ fontFamily: 'var(--np-font-mono)' }}
      />
      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
          {error}
        </p>
      ) : null}
      <Button type="submit" loading={submitting} size="lg">
        Iniciar cobro tap
      </Button>
      <p style={footnote}>
        Requiere cuenta Viva.com activa configurada por el admin del venue. Si el botón da error
        503, contacta al admin para configurar las credenciales.
      </p>
    </form>
  );
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: '1.25rem',
  fontWeight: 600,
  letterSpacing: '-0.02em',
};

const subText: CSSProperties = {
  margin: 0,
  fontSize: '0.875rem',
  color: 'var(--np-text-mute)',
};

const footnote: CSSProperties = {
  margin: 0,
  fontSize: '0.75rem',
  color: 'var(--np-text-dim)',
  textAlign: 'center',
};

const cardStyle: CSSProperties = {
  padding: '1.5rem',
  textAlign: 'center',
};

const labelText: CSSProperties = {
  margin: 0,
  fontSize: '0.7rem',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--np-text-dim)',
  fontWeight: 500,
};

const amountText: CSSProperties = {
  margin: '0.5rem 0 0',
  fontSize: '2.25rem',
  fontWeight: 600,
  letterSpacing: '-0.02em',
  color: 'var(--np-accent)',
};

const instructionCard: CSSProperties = {
  padding: '1.25rem',
  background: 'var(--np-surface-2)',
};

const instructionTitle: CSSProperties = {
  margin: '0 0 0.75rem',
  fontSize: '0.95rem',
  fontWeight: 600,
};

const instructionList: CSSProperties = {
  margin: 0,
  paddingLeft: '1.25rem',
  fontSize: '0.85rem',
  lineHeight: 1.6,
  color: 'var(--np-text)',
};

const orderCodeBox: CSSProperties = {
  marginTop: '1rem',
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.5rem 0.75rem',
  background: 'var(--np-bg)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
};

const orderCodeText: CSSProperties = {
  flex: 1,
  fontFamily: 'var(--np-font-mono)',
  fontSize: '1rem',
  letterSpacing: '0.05em',
  color: 'var(--np-text)',
  overflowX: 'auto',
};

const envHint: CSSProperties = {
  margin: '0.75rem 0 0',
  fontSize: '0.75rem',
  color: 'var(--np-text-dim)',
};
