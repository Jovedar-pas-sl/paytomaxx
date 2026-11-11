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
  // Grafito: un aviso sobre la pantalla, con filete y la sombra del diálogo
  // (sin anillo lima ni halo: la lima es para actuar); el punto verde, dinero que entra.
  borderRadius: 'var(--np-r-md)',
  background: 'var(--np-surface-2)',
  color: 'var(--np-text)',
  boxShadow: 'inset 0 0 0 1px var(--np-border-hi), 0 16px 40px -12px rgb(0 0 0 / 0.7)',
  fontWeight: 500,
  fontSize: 'var(--np-fs-16)',
  whiteSpace: 'nowrap',
};

const dot: CSSProperties = { width: '0.625rem', height: '0.625rem', borderRadius: '50%', background: 'var(--np-success)' };
