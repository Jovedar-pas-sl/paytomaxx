'use client';

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import {
  AmountKeypad,
  Button,
  Card,
  ConnectionBanner,
  Logo,
  Select,
  SERVER_DOWN_GRACE_MS,
  ThemeToggle,
  classifyConnection,
  formatEur,
  useDelayedFlag,
  useNow,
  useOnline,
  type PaymentStatus,
} from '@nightpay/ui';
import { MAX_TYPED_AMOUNT_CENTS } from '@nightpay/contracts';
import { createPayment, fetchTerminals, logout as apiLogout, type CreatedPayment } from '@/lib/api';
import { attemptFor, chargeFingerprint, type ChargeAttempt } from '@/lib/charge-attempt';
import { unlockBeep } from '@/lib/beep';
import { usePaymentStatus } from '@/lib/usePaymentStatus';
import { ActivePayment, FINISHED_STATUSES } from './ActivePayment';

interface Props {
  venueSlug: string;
  /** `revoked`: si el API también anuló la sesión (si no, caduca sola). */
  onLogout: (revoked: boolean) => void;
}

interface Terminal {
  externalId: string;
  label: string;
}

/** El cobro en pantalla y el terminal con el que se creó (para repetirlo igual). */
interface Active {
  payment: CreatedPayment;
  terminalExternalId: string;
}

export function CashRegister({ venueSlug, onLogout }: Props) {
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [terminal, setTerminal] = useState<string>('');
  // Importe del teclado propio, en céntimos (0: aún nada).
  const [amountCents, setAmountCents] = useState(0);
  const [active, setActive] = useState<Active | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  // Intento en curso: la misma Idempotency-Key si se reintenta lo mismo.
  const attemptRef = useRef<ChargeAttempt | null>(null);
  // «Otro QR · mismo importe»: una clave por cobro que se repite (dos clics, un cobro).
  const retryRef = useRef<ChargeAttempt | null>(null);
  const inFlight = useRef(false);
  const { status, reachable, checkNow } = usePaymentStatus(active?.payment ?? null);
  const issue = useConnectionIssue(active !== null, status, reachable);

  useEffect(() => {
    fetchTerminals()
      .then((list) => {
        setTerminals(list);
        if (list.length > 0) setTerminal(list[0]!.externalId);
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  async function handleSubmit(e?: FormEvent) {
    e?.preventDefault();
    if (inFlight.current) return;
    if ('vibrate' in navigator) navigator.vibrate(15);
    // Gesto de la cajera: deja listo el audio para el pitido de "pagado".
    unlockBeep();
    setError(null);
    if (amountCents <= 0) {
      setError('Pon el importe');
      return;
    }
    if (!terminal) {
      setError('Selecciona un terminal');
      return;
    }
    const attempt = attemptFor(attemptRef.current, chargeFingerprint(amountCents, terminal));
    attemptRef.current = attempt;
    inFlight.current = true;
    setSubmitting(true);
    try {
      const created = await createPayment({ amountCents, terminalExternalId: terminal }, attempt.key);
      attemptRef.current = null;
      setActive({ payment: created, terminalExternalId: terminal });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  /** Rechazado o caducado: el mismo importe en el mismo terminal, sin teclear. */
  async function retrySame() {
    if (!active || inFlight.current) return;
    unlockBeep();
    const { payment, terminalExternalId } = active;
    const attempt = attemptFor(retryRef.current, `otro-qr|${payment.id}`);
    retryRef.current = attempt;
    inFlight.current = true;
    setRetrying(true);
    setRetryError(null);
    try {
      const created = await createPayment({ amountCents: payment.amountCents, terminalExternalId }, attempt.key);
      setActive({ payment: created, terminalExternalId });
    } catch (err) {
      setRetryError((err as Error).message);
    } finally {
      inFlight.current = false;
      setRetrying(false);
    }
  }

  function newCharge() {
    setActive(null);
    setAmountCents(0);
    setRetryError(null);
  }

  async function logout() {
    setLeaving(true);
    onLogout(await apiLogout());
  }

  return (
    <main className="np-app-root np-screen" style={mainStyle}>
      {/* Sin internet / OxioPay sin responder / el banco tardando: arriba, en ámbar. */}
      <ConnectionBanner issue={issue} style={{ margin: '-1.5rem -1.5rem 0' }} />
      <header style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', minWidth: 0 }}>
          <Logo height="2rem" />
          <div style={{ borderLeft: '1px solid var(--np-border)', paddingLeft: '1rem', minWidth: 0 }}>
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
        <ActivePayment
          key={active.payment.id}
          payment={active.payment}
          status={status}
          reachable={reachable}
          checkNow={checkNow}
          onDone={newCharge}
          onRetry={() => void retrySame()}
          retrying={retrying}
          retryError={retryError}
        />
      ) : (
        <Card variant="glow" style={formCardStyle}>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
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

            {/* Teclado propio (en céntimos): en la tablet no sale el del sistema.
                Con teclado físico también vale: cifras, Retroceso e Intro. */}
            <AmountKeypad
              valueCents={amountCents}
              onChange={setAmountCents}
              maxCents={MAX_TYPED_AMOUNT_CENTS}
              disabled={submitting}
              captureKeyboard
              onEnter={() => void handleSubmit()}
            />

            <Button
              type="submit"
              loading={submitting}
              disabled={terminals.length === 0 || amountCents <= 0}
              size="lg"
            >
              {amountCents > 0 ? `Cobrar ${formatEur(amountCents)}` : 'Cobrar'}
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

/**
 * Qué falla, para la franja de arriba: sin internet; el socket caído con un
 * cobro abierto (el TPV no sabría que se ha pagado); o el banco tardando.
 */
function useConnectionIssue(hasCharge: boolean, status: PaymentStatus | null, reachable: boolean) {
  const online = useOnline();
  const open = hasCharge && status !== null && !FINISHED_STATUSES.has(status);
  const serverDown = useDelayedFlag(open && !reachable, SERVER_DOWN_GRACE_MS);
  const [authorizingSince, setAuthorizingSince] = useState<number | null>(null);
  useEffect(() => {
    setAuthorizingSince((since) => (status === 'AUTHORIZING' ? (since ?? Date.now()) : null));
  }, [status]);
  const now = useNow(authorizingSince !== null);
  return classifyConnection(
    { online, serverDown, bankWaitingSinceMs: authorizingSince, orphan: status === 'ORPHAN' },
    now,
    'register',
  );
}

const mainStyle: CSSProperties = {
  padding: '1.5rem',
  maxWidth: '64rem',
  margin: '0 auto',
  display: 'flex',
  flexDirection: 'column',
  gap: '1.5rem',
};

const formCardStyle: CSSProperties = {
  padding: '1.5rem',
  maxWidth: '30rem',
  margin: '0.5rem auto',
  width: '100%',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  // En un móvil estrecho, «Salir» baja de línea antes que sacar la página por el lado.
  flexWrap: 'wrap',
  gap: '0.75rem',
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
  fontSize: 'var(--np-t-label)',
  color: 'var(--np-text-mute)',
};

const code: CSSProperties = {
  fontFamily: 'var(--np-font-mono)',
  background: 'var(--np-surface-2)',
  padding: '0.1rem 0.4rem',
  borderRadius: '4px',
  fontSize: 'var(--np-t-label)',
  overflowWrap: 'anywhere',
};

const errStyle: CSSProperties = {
  color: 'var(--np-danger)',
  margin: 0,
  textAlign: 'center',
  fontSize: '0.9375rem',
  fontWeight: 600,
};
