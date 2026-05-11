'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { io, type Socket } from 'socket.io-client';
import { Button, Card, Input, StatusPill, type PaymentStatus } from '@nightpay/ui';
import {
  cancelPayment,
  createPayment,
  fetchTerminals,
  wsBase,
  type CreatedPayment,
} from '@/lib/api';

interface Props {
  onCreated: () => void;
}

export function CreatePayment({ onCreated }: Props) {
  const [terminals, setTerminals] = useState<Array<{ externalId: string; label: string }>>([]);
  const [amount, setAmount] = useState('');
  // Phase 1B — toggle "Cargar wallet" para crear un saldo prepago en vez de un cobro puntual.
  const [walletMode, setWalletMode] = useState(false);
  const [walletIdentifier, setWalletIdentifier] = useState('');
  const [active, setActive] = useState<CreatedPayment | null>(null);
  const [status, setStatus] = useState<PaymentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchTerminals()
      .then(setTerminals)
      .catch((err) => setError((err as Error).message));
  }, []);

  useEffect(() => {
    if (!active) return;
    const socket: Socket = io(`${wsBase}/rt`, { transports: ['websocket', 'polling'] });
    socket.on('connect', () => {
      socket.emit('payment:subscribe', { paymentId: active.id });
    });
    socket.on('payment:update', (e: { paymentId: string; status: PaymentStatus }) => {
      if (e.paymentId === active.id) setStatus(e.status);
    });
    socket.on(
      'payment:completed',
      (e: { paymentId: string; status: 'AUTHORIZED' | 'FAILED' | 'EXPIRED' | 'CANCELED' }) => {
        if (e.paymentId === active.id) {
          setStatus(e.status);
          if (e.status === 'AUTHORIZED') {
            onCreated();
          }
        }
      },
    );
    return () => {
      socket.disconnect();
    };
  }, [active, onCreated]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (terminals.length === 0) {
      setError('No hay terminales configurados en el local');
      return;
    }
    if ('vibrate' in navigator) navigator.vibrate(10);
    setSubmitting(true);
    setError(null);
    try {
      const cents = Math.round(parseFloat(amount.replace(',', '.')) * 100);
      if (!Number.isFinite(cents) || cents <= 0) throw new Error('Importe inválido');
      if (walletMode && !walletIdentifier.trim()) {
        throw new Error('Pon una etiqueta al wallet (Mesa 3, Pulsera azul...) para no confundirlo');
      }
      const created = await createPayment({
        amountCents: cents,
        terminalExternalId: terminals[0]!.externalId,
        walletIdentifier: walletMode ? walletIdentifier.trim() : undefined,
      });
      setActive(created);
      setStatus(created.status as PaymentStatus);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel() {
    if (!active) return;
    setSubmitting(true);
    try {
      await cancelPayment(active.id);
      setActive(null);
      setStatus(null);
      setAmount('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function copyUrl() {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(active.qrUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  function reset() {
    setActive(null);
    setStatus(null);
    setAmount('');
    setCopied(false);
    setError(null);
    setWalletIdentifier('');
    onCreated();
  }

  if (active) {
    const canCancel = status === 'CREATED' || status === 'AWAITING_CAPTURE';
    return (
      <Card variant="glow" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ textAlign: 'center' }}>
          <p style={kicker}>Importe</p>
          <p className="np-num" style={amountBig}>
            {(active.amountCents / 100).toFixed(2)}{' '}
            <span style={{ fontSize: '0.95rem', color: 'var(--np-text-mute)', fontWeight: 500 }}>
              {active.currency}
            </span>
          </p>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <StatusPill status={status ?? 'CREATED'} />
        </div>
        <div
          style={{
            background: 'white',
            borderRadius: 'var(--np-r-md)',
            padding: '0.75rem',
            display: 'flex',
            justifyContent: 'center',
          }}
        >
          <img
            src={active.qrPngDataUrl}
            alt="QR del cobro"
            style={{ width: '100%', maxWidth: '15rem', height: 'auto', display: 'block' }}
          />
        </div>
        <Button onClick={copyUrl} variant="ghost" size="md">
          {copied ? '✓ Copiado' : 'Copiar link del cobro'}
        </Button>

        {status === 'AUTHORIZED' ? (
          <Button onClick={reset} size="lg">
            ✓ Cobrado — nuevo
          </Button>
        ) : canCancel ? (
          <Button onClick={handleCancel} variant="danger" size="md" loading={submitting}>
            Cancelar cobro
          </Button>
        ) : (
          <Button onClick={reset} variant="ghost" size="md">
            Nuevo cobro
          </Button>
        )}

        {error ? <p style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem', textAlign: 'center' }}>{error}</p> : null}
      </Card>
    );
  }

  return (
    <Card style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <p style={{ ...kicker, textAlign: 'center' }}>
        {walletMode ? 'Cargar wallet del cliente' : 'Crear nuevo cobro'}
      </p>

      {/* Toggle entre cobro directo y cargar wallet */}
      <div style={toggleRowStyle}>
        <button
          type="button"
          onClick={() => setWalletMode(false)}
          style={{
            ...toggleBtnStyle,
            ...(walletMode ? {} : toggleBtnActiveStyle),
          }}
        >
          Cobro directo
        </button>
        <button
          type="button"
          onClick={() => setWalletMode(true)}
          style={{
            ...toggleBtnStyle,
            ...(walletMode ? toggleBtnActiveStyle : {}),
          }}
        >
          Cargar wallet
        </button>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <Input
          label="Importe (€)"
          type="text"
          inputMode="decimal"
          placeholder="50.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
          size="lg"
          autoFocus
          style={{ textAlign: 'center', fontFamily: 'var(--np-font-mono)' }}
        />

        {walletMode ? (
          <>
            <Input
              label="Etiqueta del wallet"
              type="text"
              placeholder="Ej: Mesa 3, Pulsera azul, Camisa roja"
              value={walletIdentifier}
              onChange={(e) => setWalletIdentifier(e.target.value)}
              required
            />
            <p style={hintStyle}>
              💡 El cliente paga UNA vez con este QR. Luego le cobras desde la tab Wallet sin
              molestarlo de nuevo — solo necesitas saber su etiqueta.
            </p>
          </>
        ) : null}

        <Button type="submit" size="lg" loading={submitting}>
          {walletMode ? `Cargar ${amount ? `${amount} €` : 'wallet'}` : 'Cobrar'}
        </Button>
        {error ? (
          <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem', textAlign: 'center' }}>
            {error}
          </p>
        ) : null}
      </form>
    </Card>
  );
}

const toggleRowStyle: CSSProperties = {
  display: 'flex',
  background: 'var(--np-surface-2)',
  padding: '0.25rem',
  borderRadius: 'var(--np-r-md)',
  border: '1px solid var(--np-border)',
};

const toggleBtnStyle: CSSProperties = {
  flex: 1,
  padding: '0.5rem 0.75rem',
  background: 'transparent',
  border: 'none',
  borderRadius: 'var(--np-r-sm)',
  color: 'var(--np-text-mute)',
  fontSize: '0.78rem',
  fontWeight: 500,
  cursor: 'pointer',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

const toggleBtnActiveStyle: CSSProperties = {
  background: 'var(--np-bg)',
  color: 'var(--np-text)',
  boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
};

const hintStyle: CSSProperties = {
  margin: 0,
  padding: '0.6rem 0.8rem',
  fontSize: '0.78rem',
  color: 'var(--np-text-mute)',
  background: 'var(--np-surface-2)',
  borderRadius: 'var(--np-r-md)',
  border: '1px solid var(--np-border)',
  lineHeight: 1.4,
};

const kicker: CSSProperties = {
  margin: 0,
  fontSize: '0.7rem',
  color: 'var(--np-text-dim)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 500,
};

const amountBig: CSSProperties = {
  margin: '0.25rem 0 0',
  fontSize: '2.5rem',
  fontWeight: 600,
  letterSpacing: '-0.03em',
  fontVariantNumeric: 'tabular-nums',
};
