import type { CSSProperties } from 'react';

export type PaymentStatus =
  | 'CREATED'
  | 'AWAITING_CAPTURE'
  | 'AUTHORIZING'
  | 'AUTHORIZED'
  | 'FAILED'
  | 'EXPIRED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'ORPHAN';

interface StatusPillProps {
  status: PaymentStatus;
  size?: 'sm' | 'md';
}

const config: Record<
  PaymentStatus,
  { label: string; color: string; bg: string; spin?: boolean }
> = {
  CREATED: {
    label: 'Esperando confirmación',
    color: 'var(--np-text-mute)',
    bg: 'var(--np-pill-mute-bg)',
  },
  AWAITING_CAPTURE: {
    label: 'Esperando datáfono',
    color: 'var(--np-text-mute)',
    bg: 'var(--np-pill-mute-bg)',
  },
  AUTHORIZING: {
    label: 'Procesando pago…',
    color: 'var(--np-accent)',
    bg: 'var(--np-pill-cyan-bg)',
    spin: true,
  },
  AUTHORIZED: {
    label: 'Pago completado',
    color: 'var(--np-success)',
    bg: 'var(--np-pill-success-bg)',
  },
  FAILED: {
    label: 'Pago rechazado',
    color: 'var(--np-danger)',
    bg: 'var(--np-pill-danger-bg)',
  },
  EXPIRED: {
    label: 'QR expirado',
    color: 'var(--np-warning)',
    bg: 'var(--np-pill-warning-bg)',
  },
  REFUNDED: {
    label: 'Reembolsado',
    color: 'var(--np-purple)',
    bg: 'var(--np-pill-purple-bg)',
  },
  PARTIALLY_REFUNDED: {
    label: 'Reembolso parcial',
    color: 'var(--np-purple)',
    bg: 'var(--np-pill-purple-bg)',
  },
  ORPHAN: {
    label: 'Verificando',
    color: 'var(--np-warning)',
    bg: 'var(--np-pill-warning-bg)',
    spin: true,
  },
};

export function StatusPill({ status, size = 'md' }: StatusPillProps) {
  const cfg = config[status];
  const dims =
    size === 'sm'
      ? { padding: '0.25rem 0.625rem', fontSize: '0.75rem' }
      : { padding: '0.5rem 1rem', fontSize: '0.875rem' };

  return (
    <span
      role="status"
      aria-live="polite"
      style={{
        ...pillBase,
        ...dims,
        color: cfg.color,
        background: cfg.bg,
        borderColor: cfg.color,
      } as CSSProperties}
    >
      {cfg.spin ? <Pulse color={cfg.color} /> : <Dot color={cfg.color} />}
      {cfg.label}
    </span>
  );
}

const pillBase: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.5rem',
  borderRadius: 'var(--np-r-pill)',
  border: '1px solid',
  fontWeight: 500,
  letterSpacing: '0.01em',
  fontFamily: 'var(--np-font-sans)',
  transition: 'background var(--np-d-base), color var(--np-d-base), border-color var(--np-d-base)',
};

function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      style={{
        width: '0.5rem',
        height: '0.5rem',
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

function Pulse({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      style={{
        position: 'relative',
        width: '0.5rem',
        height: '0.5rem',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          background: color,
          animation: 'np-pulse-ring 1.4s ease-out infinite',
        }}
      />
      <span
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          background: color,
        }}
      />
      <style>{`
        @keyframes np-pulse-ring {
          0%   { transform: scale(1);   opacity: 0.7; }
          100% { transform: scale(2.4); opacity: 0;   }
        }
      `}</style>
    </span>
  );
}
