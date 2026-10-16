import type { ReactNode } from 'react';
import {
  countdownPhase,
  formatClock,
  remainingFraction,
  secondsLeft,
  type QrDeadline,
} from '../lib/countdown';

interface QrCountdownProps {
  /** null: sin plazo conocido (se enseña el QR sin cuenta atrás). */
  deadline: QrDeadline | null;
  /** La hora de ahora (useNow de quien lo usa, que también decide cuándo caduca). */
  nowMs: number;
  /** El QR (con su fondo blanco). */
  children: ReactNode;
}

/**
 * El QR con su cuenta atrás debajo: una barra que se vacía y el tiempo en
 * texto. En el último minuto, ámbar y «Caduca pronto»; caducado, el QR se
 * apaga y lo dice. La barra se mueve con transform.
 */
export function QrCountdown({ deadline, nowMs, children }: QrCountdownProps) {
  if (!deadline) return <>{children}</>;
  const seconds = secondsLeft(deadline, nowMs);
  const phase = countdownPhase(seconds);
  const fraction = remainingFraction(deadline, nowMs);
  const text =
    phase === 'over'
      ? 'QR caducado'
      : phase === 'ending'
        ? `Caduca pronto · ${formatClock(seconds)}`
        : `Caduca en ${formatClock(seconds)}`;

  return (
    <div className="np-qrcd" data-phase={phase}>
      <div className="np-qrcd-frame">{children}</div>
      <div className="np-qrcd-track" aria-hidden="true">
        <div className="np-qrcd-fill" style={{ transform: `scaleX(${fraction.toFixed(4)})` }} />
      </div>
      <p className="np-qrcd-label" role="timer">
        {text}
      </p>
    </div>
  );
}
