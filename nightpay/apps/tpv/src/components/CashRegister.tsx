'use client';

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input, Logo, Select, ThemeToggle } from '@nightpay/ui';
import { parseEuroCents } from '@nightpay/contracts';
import { createPayment, fetchTerminals, logout as apiLogout, type CreatedPayment } from '@/lib/api';
import { attemptFor, chargeFingerprint, type ChargeAttempt } from '@/lib/charge-attempt';
import { unlockBeep } from '@/lib/beep';
import { usePaymentStatus } from '@/lib/usePaymentStatus';
import { ActivePayment } from './ActivePayment';

interface Props {
  venueSlug: string;
  /** `revoked`: si el API también anuló la sesión (si no, caduca sola). */
  onLogout: (revoked: boolean) => void;
}

interface Terminal {
  externalId: string;
  label: string;
}

export function CashRegister({ venueSlug, onLogout }: Props) {
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [terminal, setTerminal] = useState<string>('');
  const [amount, setAmount] = useState('');
  const [active, setActive] = useState<CreatedPayment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // Intento en curso: la misma Idempotency-Key si se reintenta lo mismo.
  const attemptRef = useRef<ChargeAttempt | null>(null);
  const { status, live } = usePaymentStatus(active);

  useEffect(() => {
    fetchTerminals()
      .then((list) => {
        setTerminals(list);
        if (list.length > 0) setTerminal(list[0]!.externalId);
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if ('vibrate' in navigator) navigator.vibrate(15);
    // Gesto de la cajera: deja listo el audio para el pitido de "pagado".
    unlockBeep();
    setError(null);
    const cents = parseEuroCents(amount);
    if (cents === null) {
      setError('Importe inválido');
      return;
    }
    if (!terminal) {
      setError('Selecciona un terminal');
      return;
    }
    const attempt = attemptFor(attemptRef.current, chargeFingerprint(cents, terminal));
    attemptRef.current = attempt;
    setSubmitting(true);
    try {
      const created = await createPayment({ amountCents: cents, terminalExternalId: terminal }, attempt.key);
      attemptRef.current = null;
      setActive(created);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function newCharge() {
    setActive(null);
    setAmount('');
  }

  async function logout() {
    setLeaving(true);
    onLogout(await apiLogout());
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
          <Button variant="ghost" size="md" onClick={logout} loading={leaving}>
            Salir
          </Button>
        </div>
      </header>

      {active ? (
        <ActivePayment payment={active} status={status} live={live} onDone={newCharge} />
      ) : (
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
              placeholder="48,50"
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
      )}
    </main>
  );
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingBottom: '1rem',
  borderBottom: '1px solid var(--np-border)',
};

const brandLabel: CSSProperties = {
  margin: 0,
  fontSize: '0.95rem',
  fontWeight: 600,
  letterSpacing: '-0.01em',
};

const brandSub: CSSProperties = {
  margin: '0.25rem 0 0',
  fontSize: '0.75rem',
  color: 'var(--np-text-mute)',
};

const code: CSSProperties = {
  fontFamily: 'var(--np-font-mono)',
  background: 'var(--np-surface-2)',
  padding: '0.1rem 0.4rem',
  borderRadius: '4px',
  fontSize: '0.75rem',
};

const errStyle: CSSProperties = {
  color: 'var(--np-danger)',
  margin: 0,
  textAlign: 'center',
  fontSize: '0.875rem',
};
