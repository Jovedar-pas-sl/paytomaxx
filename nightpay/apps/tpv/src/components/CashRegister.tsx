'use client';

import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
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

type ActiveStatus =
  | 'CREATED'
  | 'AWAITING_CAPTURE'
  | 'AUTHORIZING'
  | 'AUTHORIZED'
  | 'FAILED'
  | 'EXPIRED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'ORPHAN';

export function CashRegister({ venueSlug, onLogout }: Props) {
  const [terminals, setTerminals] = useState<Array<{ externalId: string; label: string }>>([]);
  const [terminal, setTerminal] = useState<string>('');
  const [amount, setAmount] = useState('');
  const [active, setActive] = useState<CreatedPayment | null>(null);
  const [status, setStatus] = useState<ActiveStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Carga terminales al entrar
  useEffect(() => {
    fetchTerminals()
      .then((list) => {
        setTerminals(list);
        if (list.length > 0) setTerminal(list[0]!.externalId);
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  // Socket.io: suscribirse al pago activo
  useEffect(() => {
    if (!active) return;
    const socket: Socket = io(`${wsBase}/rt`, { transports: ['websocket', 'polling'] });
    socket.on('connect', () => {
      socket.emit('payment:subscribe', { paymentId: active.id });
    });
    socket.on('payment:update', (e: { paymentId: string; status: ActiveStatus }) => {
      if (e.paymentId === active.id) setStatus(e.status);
    });
    socket.on(
      'payment:completed',
      (e: { paymentId: string; status: 'AUTHORIZED' | 'FAILED' | 'EXPIRED' }) => {
        if (e.paymentId === active.id) {
          setStatus(e.status);
          if (e.status === 'AUTHORIZED') {
            playBeep();
          }
        }
      },
    );
    return () => {
      socket.disconnect();
    };
  }, [active]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const cents = Math.round(parseFloat(amount.replace(',', '.')) * 100);
      if (!Number.isFinite(cents) || cents <= 0) {
        throw new Error('Importe inválido');
      }
      if (!terminal) {
        throw new Error('Selecciona un terminal');
      }
      const created = await createPayment({ amountCents: cents, terminalExternalId: terminal });
      setActive(created);
      setStatus(created.status as ActiveStatus);
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
  }

  async function logout() {
    await apiLogout();
    onLogout();
  }

  return (
    <main style={pageStyle}>
      <header style={headerStyle}>
        <strong>NightPay TPV</strong> · venue: <code>{venueSlug}</code>
        <button onClick={logout} style={logoutBtn}>
          Salir
        </button>
      </header>

      {!active ? (
        <form onSubmit={handleSubmit} style={formStyle}>
          <select
            value={terminal}
            onChange={(e) => setTerminal(e.target.value)}
            style={inputStyle}
            required
          >
            {terminals.length === 0 && <option value="">— sin terminales —</option>}
            {terminals.map((t) => (
              <option key={t.externalId} value={t.externalId}>
                {t.label} ({t.externalId})
              </option>
            ))}
          </select>

          <input
            type="text"
            inputMode="decimal"
            placeholder="Importe (€) ej. 48.50"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            style={amountInput}
            autoFocus
          />

          <button type="submit" disabled={submitting || terminals.length === 0} style={primaryBtn}>
            {submitting ? 'Creando QR…' : 'Cobrar'}
          </button>

          {error && <p style={errorStyle}>{error}</p>}
        </form>
      ) : (
        <div style={qrViewStyle}>
          <p style={{ color: '#aaa', margin: 0 }}>
            {(active.amountCents / 100).toFixed(2)} {active.currency}
          </p>
          <img
            src={active.qrPngDataUrl}
            alt="QR"
            style={{ width: 320, height: 320, marginTop: '1rem', borderRadius: '0.5rem' }}
          />

          <div style={qrUrlBoxStyle}>
            <span style={{ color: '#888', fontSize: '0.75rem' }}>URL del QR (copiar y abrir en otro navegador):</span>
            <div style={qrUrlRowStyle}>
              <code style={qrUrlCodeStyle}>{active.qrUrl}</code>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(active.qrUrl);
                  } catch {
                    /* fallback: select */
                  }
                }}
                style={copyBtnStyle}
              >
                Copiar
              </button>
            </div>
          </div>

          <StatusView status={status ?? 'CREATED'} />
          <button onClick={reset} style={cancelBtn}>
            Cancelar / Nuevo cobro
          </button>
        </div>
      )}
    </main>
  );
}

function StatusView({ status }: { status: ActiveStatus }) {
  const map: Record<ActiveStatus, { label: string; color: string }> = {
    CREATED: { label: 'Esperando que el cliente escanee', color: '#aaa' },
    AWAITING_CAPTURE: { label: 'Esperando datáfono', color: '#aaa' },
    AUTHORIZING: { label: '⟳ Procesando con pasarela…', color: '#4fc3f7' },
    AUTHORIZED: { label: '✓ Cobrado', color: '#66bb6a' },
    FAILED: { label: '✗ Rechazado', color: '#ef5350' },
    EXPIRED: { label: 'QR expirado', color: '#ffa726' },
    REFUNDED: { label: 'Reembolsado', color: '#ab47bc' },
    PARTIALLY_REFUNDED: { label: 'Reembolso parcial', color: '#ab47bc' },
    ORPHAN: { label: 'Verificando…', color: '#ffa726' },
  };
  const v = map[status];
  return (
    <p
      style={{
        marginTop: '1.5rem',
        color: v.color,
        fontSize: '1.2rem',
        fontWeight: 500,
      }}
    >
      {v.label}
    </p>
  );
}

function playBeep() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // ignore
  }
}

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  padding: '1.5rem',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '1rem',
  paddingBottom: '1.5rem',
  borderBottom: '1px solid #333',
  marginBottom: '2rem',
};

const logoutBtn: React.CSSProperties = {
  marginLeft: 'auto',
  padding: '0.4rem 0.8rem',
  fontSize: '0.85rem',
  background: 'transparent',
  color: '#aaa',
  border: '1px solid #444',
  borderRadius: '0.4rem',
  cursor: 'pointer',
};

const formStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  maxWidth: '24rem',
  margin: '0 auto',
};

const inputStyle: React.CSSProperties = {
  padding: '0.75rem 1rem',
  fontSize: '1rem',
  border: '1px solid #444',
  borderRadius: '0.5rem',
  background: '#1a1a1f',
  color: '#fff',
};

const amountInput: React.CSSProperties = {
  ...inputStyle,
  fontSize: '2rem',
  fontWeight: 600,
  textAlign: 'center',
};

const primaryBtn: React.CSSProperties = {
  padding: '1rem',
  fontSize: '1.2rem',
  fontWeight: 600,
  background: '#fafafa',
  color: '#0b0b10',
  border: 'none',
  borderRadius: '0.5rem',
  cursor: 'pointer',
};

const qrViewStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  textAlign: 'center',
};

const cancelBtn: React.CSSProperties = {
  marginTop: '1.5rem',
  padding: '0.75rem 1.5rem',
  background: 'transparent',
  color: '#aaa',
  border: '1px solid #444',
  borderRadius: '0.5rem',
  cursor: 'pointer',
};

const qrUrlBoxStyle: React.CSSProperties = {
  marginTop: '1rem',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '0.4rem',
  width: '100%',
  maxWidth: '36rem',
};

const qrUrlRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'center',
  width: '100%',
};

const qrUrlCodeStyle: React.CSSProperties = {
  flex: 1,
  padding: '0.5rem 0.75rem',
  fontSize: '0.75rem',
  fontFamily: 'monospace',
  background: '#1a1a1f',
  color: '#fafafa',
  border: '1px solid #444',
  borderRadius: '0.4rem',
  userSelect: 'all',
  overflowX: 'auto',
  whiteSpace: 'nowrap',
};

const copyBtnStyle: React.CSSProperties = {
  padding: '0.5rem 0.9rem',
  fontSize: '0.8rem',
  background: '#fafafa',
  color: '#0b0b10',
  border: 'none',
  borderRadius: '0.4rem',
  cursor: 'pointer',
};

const errorStyle: React.CSSProperties = {
  color: '#ef5350',
  margin: 0,
  textAlign: 'center',
};
