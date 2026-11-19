'use client';

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import {
  AmountKeypad,
  Button,
  Card,
  ConnectionBanner,
  FormError,
  Logo,
  Select,
  SERVER_DOWN_GRACE_MS,
  ScreenHelp,
  ThemeToggle,
  classifyConnection,
  formatEur,
  useDelayedFlag,
  useNow,
  useOnline,
  type PaymentStatus,
  haptic,
} from '@nightpay/ui';
import { MAX_TYPED_AMOUNT_CENTS } from '@nightpay/contracts';
import { createPayment, fetchTerminals, fetchVenueName, logout as apiLogout, type CreatedPayment } from '@/lib/api';
import { attemptFor, chargeFingerprint, type ChargeAttempt } from '@/lib/charge-attempt';
import { unlockBeep } from '@/lib/beep';
import { usePaymentStatus } from '@/lib/usePaymentStatus';
import { TOURS } from '@/lib/tours';
import { ActivePayment, FINISHED_STATUSES } from './ActivePayment';
import styles from './cash-register.module.css';

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
  // El nombre del local: arriba en el ticket impreso (sin él, el ticket sale igual).
  const [venueName, setVenueName] = useState<string | null>(null);
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
    fetchVenueName()
      .then(setVenueName)
      .catch(() => setVenueName(null));
  }, []);

  async function handleSubmit(e?: FormEvent) {
    e?.preventDefault();
    if (inFlight.current) return;
    haptic();
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
      <ConnectionBanner issue={issue} style={{ margin: 'calc(-1 * var(--tpv-pad)) calc(-1 * var(--tpv-pad)) 0' }} />
      <header style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
          <span className={styles.logoFull}>
            <Logo height="2rem" />
          </span>
          <span className={styles.logoMark}>
            <Logo variant="symbol" height="2.25rem" />
          </span>
          <div style={{ borderLeft: '1px solid var(--np-border)', paddingLeft: '0.75rem', minWidth: 0 }}>
            <p style={brandLabel}>TPV</p>
            <p className={styles.venueLine} style={brandSub}>
              Local <code style={code}>{venueSlug}</code>
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {/* El «?» de la pantalla que se ve: cobro o espera. En la espera, solo a mano (hay un cobro abierto). */}
          {active ? (
            <ScreenHelp key="espera" {...TOURS.espera} ready={false} />
          ) : (
            <ScreenHelp key="cobro" {...TOURS.cobro} ready={!submitting && amountCents === 0} />
          )}
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
          venueName={venueName}
          status={status}
          reachable={reachable}
          checkNow={checkNow}
          onDone={newCharge}
          onRetry={() => void retrySame()}
          retrying={retrying}
          retryError={retryError}
        />
      ) : (
        <Card style={formCardStyle}>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Select
              label="Terminal"
              value={terminal}
              onChange={(e) => setTerminal(e.target.value)}
              required
              data-tour="tpv-terminal"
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
            <div data-tour="tpv-teclado">
              <AmountKeypad
                valueCents={amountCents}
                onChange={setAmountCents}
                maxCents={MAX_TYPED_AMOUNT_CENTS}
                disabled={submitting}
                captureKeyboard
                onEnter={() => void handleSubmit()}
              />
            </div>

            <Button
              type="submit"
              loading={submitting}
              loadingLabel="Cobrando"
              disabled={terminals.length === 0 || amountCents <= 0}
              size="lg"
              data-tour="tpv-cobrar"
            >
              {amountCents > 0 ? `Cobrar ${formatEur(amountCents)}` : 'Cobrar'}
            </Button>

            {error ? <FormError>{error}</FormError> : null}
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

// Margen de 16 en el móvil y 24 en la tableta (Grafito); la franja de
// conexión lo deshace para ir de lado a lado.
const mainStyle = {
  '--tpv-pad': 'clamp(1rem, 4vw, 1.5rem)',
  padding: 'var(--tpv-pad)',
  maxWidth: '64rem',
  margin: '0 auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--tpv-pad)',
} as CSSProperties;

const formCardStyle: CSSProperties = {
  padding: 'clamp(1rem, 4vw, 1.5rem)',
  maxWidth: '30rem',
  margin: '0 auto',
  width: '100%',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  // Si aun así no cupiera, «Salir» baja de línea antes que sacar la página por el lado.
  flexWrap: 'wrap',
  gap: '0.75rem',
  paddingBottom: 'clamp(0.75rem, 3vw, 1rem)',
  borderBottom: '1px solid var(--np-border)',
};

const brandLabel: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-fs-16)',
  fontWeight: 600,
};

const brandSub: CSSProperties = {
  margin: '0.25rem 0 0',
  fontSize: 'var(--np-fs-14)',
  color: 'var(--np-text-mute)',
};

// El identificador del local es un código: en cifras, en su chip (radio 6).
const code: CSSProperties = {
  fontFamily: 'var(--np-font-mono)',
  fontWeight: 600,
  background: 'var(--np-surface-2)',
  padding: '0.1rem 0.4rem',
  borderRadius: 'var(--np-r-xs)',
  fontSize: 'var(--np-fs-14)',
  overflowWrap: 'anywhere',
};
