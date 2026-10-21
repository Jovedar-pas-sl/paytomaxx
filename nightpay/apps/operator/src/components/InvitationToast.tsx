'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { MyNight } from '@/lib/api';
import { formatEur } from '@/lib/money';
import { playOutcomeSound } from '@/lib/alert-sound';
import { invitationArrived } from '@/lib/invitation-toast';

const SHOW_MS = 6000;

/**
 * «Te han invitado · +10 €» (maqueta 2.5): la chica lo ve en su app al
 * momento de cobrarse la invitación (con el sondeo de su noche). Suena y
 * vibra como un PAGADO.
 */
export function InvitationToast({ night }: { night: MyNight | null }) {
  const last = useRef<MyNight['invitations'] | null>(null);
  const [shown, setShown] = useState<number | null>(null);

  useEffect(() => {
    const now = night?.invitations ?? null;
    const cents = invitationArrived(last.current, now);
    last.current = now ?? last.current;
    if (cents === null) return;
    setShown(cents);
    playOutcomeSound('paid');
  }, [night]);

  useEffect(() => {
    if (shown === null) return undefined;
    const t = setTimeout(() => setShown(null), SHOW_MS);
    return () => clearTimeout(t);
  }, [shown]);

  if (shown === null) return null;
  return (
    <p role="status" style={toast}>
      <span style={dot} aria-hidden="true" />
      Te han invitado · <b className="np-num">+{formatEur(shown, { compact: true })}</b>
    </p>
  );
}

const toast: CSSProperties = {
  position: 'fixed',
  top: 'calc(0.75rem + env(safe-area-inset-top, 0px))',
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 120,
  margin: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.5rem',
  minHeight: '3rem',
  padding: '0 1.25rem',
  borderRadius: 'var(--np-r-pill)',
  background: 'var(--np-card-oxio)',
  color: 'var(--np-cream)',
  boxShadow: '0 0 0 1.5px var(--np-lime), 0 12px 32px -12px var(--np-lime-glow)',
  fontWeight: 700,
  fontSize: '1.0625rem',
  whiteSpace: 'nowrap',
};

const dot: CSSProperties = { width: '0.625rem', height: '0.625rem', borderRadius: '50%', background: 'var(--np-lime)' };
