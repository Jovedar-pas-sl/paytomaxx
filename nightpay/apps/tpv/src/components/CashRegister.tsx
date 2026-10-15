'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  AmountDisplay,
  Button,
  Card,
  Input,
  Logo,
  Select,
  StatusPill,
  ThemeToggle,
  type PaymentStatus,
} from '@nightpay/ui';
import { parseEuroCents } from '@nightpay/contracts';
import {
  createPayment,
  fetchTerminals,
  logout as apiLogout,
  wsBase,
  type CreatedPayment,
} from '@/lib/api';

interface Props {
  venueSlug: string;
  onLogout: () => void;
}

export function CashRegister({ venueSlug, onLogout }: Props) {
  const [terminals, setTerminals] = useState<Array<{ externalId: string; label: string }>>([]);
  const [terminal, setTerminal] = useState<string>('');
  const [amount, setAmount] = useState('');
  const [active, setActive] = useState<CreatedPayment | null>(null);
  const [status, setStatus] = useState<PaymentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchTerminals()
      .then((list) => {
        setTerminals(list);
        if (list.length > 0) setTerminal(list[0]!.externalId);
      })
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
      (e: { paymentId: string; status: 'AUTHORIZED' | 'FAILED' | 'EXPIRED' }) => {
        if (e.paymentId === active.id) {
          setStatus(e.status);
          if (e.status === 'AUTHORIZED') playBeep();
        }
      },
    );
    return () => {
      socket.disconnect();
    };
  }, [active]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if ('vibrate' in navigator) navigator.vibrate(15);
    setError(null);
    setSubmitting(true);
    try {
      const cents = parseEuroCents(amount);
      if (cents === null) throw new Error('Importe inválido');
      if (!terminal) throw new Error('Selecciona un terminal');
      const created = await createPayment({ amountCents: cents, terminalExternalId: terminal });
      setActive(created);
      setStatus(created.status as PaymentStatus);
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
    setCopied(false);
  }

  async function logout() {
    await apiLogout();
    onLogout();
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

  return (
    <main
      className="np-app-root np-screen"
      style={{
        padding: '1.5rem',
        maxWidth: '64rem',
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.5rem',
      }}
    >
      <header style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <Logo height="2rem" />
          <div style={{ borderLeft: '1px solid var(--np-border)', paddingLeft: '1rem' }}>
            <p style={brandLabel}>TPV</p>
            <p style={brandSub}>
              venue <code style={code}>{venueSlug}</code>
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <ThemeToggle />
          <Button variant="ghost" size="md" onClick={logout}>
            Salir
          </Button>
        </div>
      </header>

      {!active ? (
        <Card variant="glow" style={{ padding: '2rem', maxWidth: '32rem', margin: '2rem auto', width: '100%' }}>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <Select
              label="Terminal"
              value={terminal}
              onChange={(e) => setTerminal(e.target.value)}
              required
            >
              {terminals.length === 0 && <option value="">— sin terminales —</option>}
              {terminals.map((t) => (
                <option key={t.externalId} value={t.externalId}>
                  {t.label} ({t.externalId})
                </option>
              ))}
            </Select>

            <Input
              label="Importe (€)"
              type="text"
              inputMode="decimal"
              placeholder="48.50"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
              size="lg"
              autoFocus
              style={{ textAlign: 'center', fontFamily: 'var(--np-font-mono)' }}
            />

            <Button type="submit" loading={submitting} disabled={terminals.length === 0} size="lg">
              Cobrar
            </Button>

            {error ? (
              <p role="alert" style={errStyle}>
                {error}
              </p>
            ) : null}
          </form>
        </Card>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '2rem', alignItems: 'start' }}>
          <Card style={{ padding: '2rem' }}>
            <p style={sectionLabel}>QR del cobro</p>
            <div
              style={{
                marginTop: '1rem',
                background: 'white',
                borderRadius: 'var(--np-r-md)',
                padding: '1rem',
                display: 'flex',
                justifyContent: 'center',
              }}
            >
              <img
                src={active.qrPngDataUrl}
                alt="QR"
                style={{ width: '100%', maxWidth: 320, height: 'auto', display: 'block' }}
              />
            </div>
            <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <p style={{ ...sectionLabel, marginTop: 0 }}>URL</p>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'stretch' }}>
                <code style={urlCode}>{active.qrUrl}</code>
                <Button variant="ghost" size="md" onClick={copyUrl}>
                  {copied ? '✓ Copiado' : 'Copiar'}
                </Button>
              </div>
            </div>
          </Card>

          <Card variant="glow" style={{ padding: '2rem', textAlign: 'center' }}>
            <p style={sectionLabel}>Importe</p>
            <AmountDisplay
              amountCents={active.amountCents}
              currency={active.currency}
              status={status ?? 'CREATED'}
            />
            <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'center' }}>
              <StatusPill status={status ?? 'CREATED'} />
            </div>
            <div style={{ marginTop: '2rem' }}>
              <Button variant="ghost" size="md" onClick={reset}>
                Cancelar / Nuevo cobro
              </Button>
            </div>
          </Card>
        </div>
      )}
    </main>
  );
}

function playBeep() {
  try {
    const Ctor: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.2, ctx.currentTime);
    o.start();
    o.stop(ctx.currentTime + 0.18);
  } catch {
    /* ignore */
  }
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingBottom: '1rem',
  borderBottom: '1px solid var(--np-border)',
};

const brandLabel: React.CSSProperties = {
  margin: 0,
  fontSize: '0.95rem',
  fontWeight: 600,
  letterSpacing: '-0.01em',
};

const brandSub: React.CSSProperties = {
  margin: '0.25rem 0 0',
  fontSize: '0.75rem',
  color: 'var(--np-text-mute)',
};

const code: React.CSSProperties = {
  fontFamily: 'var(--np-font-mono)',
  background: 'var(--np-surface-2)',
  padding: '0.1rem 0.4rem',
  borderRadius: '4px',
  fontSize: '0.75rem',
};

const sectionLabel: React.CSSProperties = {
  fontSize: '0.7rem',
  fontWeight: 500,
  color: 'var(--np-text-dim)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  margin: 0,
};

const urlCode: React.CSSProperties = {
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

const errStyle: React.CSSProperties = {
  color: 'var(--np-danger)',
  margin: 0,
  textAlign: 'center',
  fontSize: '0.875rem',
};
