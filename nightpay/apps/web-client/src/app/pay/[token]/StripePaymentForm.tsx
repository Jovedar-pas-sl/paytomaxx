'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { loadStripe, type Stripe, type StripeElementsOptions } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import { Button } from '@nightpay/ui';
import { startAuthorization } from '@/lib/api';

interface Props {
  publishableKey: string;
  clientSecret: string;
  amountCents: number;
  currency: string;
  /** qrToken — necesario para llamar a startAuthorization antes del confirm. */
  token: string;
  onError?: (msg: string) => void;
}

/**
 * Wrapper que carga Stripe.js (una sola vez por publishableKey) y monta
 * el `<Elements>` provider con el `clientSecret` del PaymentIntent.
 *
 * Tras `confirmPayment`, NO redirigimos — Stripe hace el confirm en el
 * mismo dominio y el resultado real lo recibe el backend via webhook,
 * que se propaga al frontend por WebSocket. Si Stripe pide redirect
 * obligatorio (3DS), volverá a esta misma URL.
 */
export function StripePaymentForm(props: Props) {
  const stripePromise = useMemo(() => loadStripeOnce(props.publishableKey), [props.publishableKey]);
  const options: StripeElementsOptions = useMemo(
    () => ({
      clientSecret: props.clientSecret,
      appearance: {
        theme: 'night',
        variables: {
          colorPrimary: '#36c5ff',
          colorBackground: 'transparent',
          colorText: '#f2f3f7',
          colorTextSecondary: '#9aa0a6',
          colorDanger: '#ef5350',
          fontFamily: 'Inter, system-ui, sans-serif',
          borderRadius: '12px',
          spacingUnit: '4px',
        },
        rules: {
          '.Input': {
            backgroundColor: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.12)',
          },
          '.Input:focus': {
            border: '1px solid #36c5ff',
            boxShadow: '0 0 0 3px rgba(54,197,255,0.2)',
          },
        },
      },
    }),
    [props.clientSecret],
  );

  return (
    <Elements stripe={stripePromise} options={options}>
      <InnerForm {...props} />
    </Elements>
  );
}

function InnerForm({ amountCents, currency, token, onError }: Props) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    if ('vibrate' in navigator) navigator.vibrate(15);
    setSubmitting(true);
    setError(null);

    // Transicionar el FSM a AUTHORIZING antes de confirmar la tarjeta.
    // Idempotente — si ya esta authorizing por re-submit, el backend ignora.
    try {
      await startAuthorization(token);
    } catch (err) {
      // No bloquear el pago por esto — el webhook posterior podra recuperar
      // el estado igual. Solo logueamos.
      // eslint-disable-next-line no-console
      console.warn('startAuthorization failed (continuing):', err);
    }

    try {
      const { error: confirmError } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          // return_url se usa solo si Stripe necesita redirect (3DS). En sandbox
          // con tarjeta 4242 normalmente no redirige y volvemos al flow inline.
          return_url: typeof window !== 'undefined' ? window.location.href : '',
        },
        redirect: 'if_required',
      });

      if (confirmError) {
        const msg = confirmError.message ?? 'Error al procesar el pago';
        setError(msg);
        onError?.(msg);
        setSubmitting(false);
        return;
      }
      // Si llegamos aquí sin redirect: el PaymentIntent ya está en succeeded
      // (o requires_capture). El estado AUTHORIZED se confirma vía webhook → WS,
      // no aquí. Mantenemos submitting hasta que el padre detecte el cambio.
    } catch (err) {
      // Stripe.js puede throw (network, CSP, abort) — recuperamos el form para
      // que el cliente pueda reintentar en vez de quedar atascado.
      const msg = (err as Error)?.message ?? 'Error de red al confirmar el pago';
      setError(msg);
      onError?.(msg);
      setSubmitting(false);
    }
  }

  const amountFmt = (amountCents / 100).toFixed(2);

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', width: '100%' }}>
      <PaymentElement onReady={() => setReady(true)} />
      <Button type="submit" size="lg" disabled={!ready || submitting} loading={submitting}>
        {submitting ? 'Procesando…' : `Pagar ${amountFmt} ${currency}`}
      </Button>
      {error ? (
        <p
          role="alert"
          style={{
            color: 'var(--np-danger)',
            margin: 0,
            fontSize: '0.875rem',
            textAlign: 'center',
          }}
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}

// loadStripe es promise-cached en su libreria, pero la cacheamos aqui tambien
// para no llamar `loadStripe(pk)` en cada render del padre.
const stripeCache = new Map<string, Promise<Stripe | null>>();
function loadStripeOnce(pk: string): Promise<Stripe | null> {
  let p = stripeCache.get(pk);
  if (!p) {
    p = loadStripe(pk);
    stripeCache.set(pk, p);
  }
  return p;
}
