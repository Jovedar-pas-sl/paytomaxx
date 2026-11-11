'use client';

import { useEffect, useRef } from 'react';
import { PaymentOutcome, type PaymentOutcomeProps } from '@nightpay/ui';
import { playOutcomeSound, type OutcomeSound } from '@/lib/alert-sound';

/**
 * El resultado a pantalla completa de la app, con su sonido (dos notas que
 * suben si se pagó; una grave si no) y su vibración en Android. Suena una vez
 * por resultado, también en desarrollo (StrictMode monta dos veces).
 */
export function StaffOutcome({ sound, ...props }: PaymentOutcomeProps & { sound?: OutcomeSound }) {
  const played = useRef<string | null>(null);
  useEffect(() => {
    if (played.current === props.kind) return;
    played.current = props.kind;
    // Un sonido propio si lo pide (la ficha dada, B5); si no, el de pagado o el de no pagado.
    playOutcomeSound(sound ?? (props.kind === 'paid' ? 'paid' : 'failed'));
  }, [props.kind]);
  return <PaymentOutcome {...props} />;
}
