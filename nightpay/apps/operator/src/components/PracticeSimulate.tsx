'use client';

import type { CSSProperties } from 'react';
import { usePractice } from '@/lib/practice';
import { finishPracticeCobro } from '@/lib/practice-sim';

/** Los botones que solo existen en práctica: hacen el papel del cliente (pagar, no pagar, acercar la ficha). */
export function PracticeSimulateView({
  on,
  onPaid,
  onFail,
  onFicha,
}: {
  on: boolean;
  onPaid: () => void;
  onFail: () => void;
  onFicha?: () => void;
}) {
  if (!on) return null;
  return (
    <div style={box} data-practice-actions="">
      <button type="button" style={btn} onClick={onPaid}>
        Simular: el cliente paga
      </button>
      <button type="button" style={btn} onClick={onFail}>
        Simular: no paga
      </button>
      {onFicha ? (
        <button type="button" style={btn} onClick={onFicha}>
          Simular ficha
        </button>
      ) : null}
    </div>
  );
}

/** Sobre un cobro de práctica abierto (el de tarjeta, el del saldo o los dos). */
export function PracticeSimulate({
  paymentId,
  chargeId,
  onFicha,
}: {
  paymentId?: string | null;
  chargeId?: string | null;
  onFicha?: () => void;
}) {
  const target = { paymentId, chargeId };
  return (
    <PracticeSimulateView
      on={usePractice()}
      onPaid={() => finishPracticeCobro(target, 'paid')}
      onFail={() => finishPracticeCobro(target, 'fail')}
      onFicha={onFicha}
    />
  );
}

const box: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '100%', marginBottom: '0.75rem' };

// Discontinuo y en ámbar: se ve que no es un botón de verdad de OxioPay.
const btn: CSSProperties = {
  minHeight: '3rem',
  padding: '0 1rem',
  borderRadius: 'var(--np-r-md)',
  border: '2px dashed var(--np-warning)',
  background: 'transparent',
  color: 'var(--np-text)',
  font: '600 var(--np-fs-16)/1.15 var(--np-font-sans)',
  cursor: 'pointer',
};
