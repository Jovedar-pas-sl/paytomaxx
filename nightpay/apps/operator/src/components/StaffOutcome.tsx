'use client';

import { useEffect, useRef } from 'react';
import { PaymentOutcome, type PaymentOutcomeProps } from '@nightpay/ui';
import { playOutcomeSound } from '@/lib/alert-sound';

/**
 * El resultado a pantalla completa de la app, con su sonido (dos notas que
 * suben si se pagó; una grave si no) y su vibración en Android. Suena una vez
 * por resultado, también en desarrollo (StrictMode monta dos veces).
 */
export function StaffOutcome(props: PaymentOutcomeProps) {
  const played = useRef<string | null>(null);
  useEffect(() => {
    if (played.current === props.kind) return;
    played.current = props.kind;
    playOutcomeSound(props.kind === 'paid' ? 'paid' : 'failed');
  }, [props.kind]);
  return <PaymentOutcome {...props} />;
}
