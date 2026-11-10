import type { CSSProperties } from 'react';

export type PaymentStatus =
  | 'CREATED'
  | 'AWAITING_CAPTURE'
  | 'AUTHORIZING'
  | 'AUTHORIZED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'ORPHAN';

interface StatusPillProps {
  status: PaymentStatus;
  size?: 'sm' | 'md';
  /**
   * `operator` (default) — labels desde la perspectiva de la chica:
   *   "Esperando datáfono", "Esperando pago"
   * `client` — labels desde la perspectiva del cliente que paga:
   *   "Toca PAGAR", "Procesando tu pago"
   */
  perspective?: 'operator' | 'client';
}

interface StatusConfig {
  label: string;
  color: string;
  bg: string;
  spin?: boolean;
}

const operatorConfig: Record<PaymentStatus, StatusConfig> = {
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
    // Vale para QR (cliente en la página del banco) y para datáfono. En
    // neutro con el punto que late: el lima es para la acción y el «pagado».
    label: 'Esperando pago',
    color: 'var(--np-text)',
    bg: 'var(--np-pill-mute-bg)',
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
  CANCELED: {
    label: 'Cancelado',
    color: 'var(--np-text-mute)',
    bg: 'var(--np-pill-mute-bg)',
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
  // ORPHAN = el banco no confirmó a tiempo. No gira: no se resuelve solo,
  // hay que mirarlo en el banco.
  ORPHAN: {
    label: 'Sin confirmar',
    color: 'var(--np-warning)',
    bg: 'var(--np-pill-warning-bg)',
  },
};

// Labels reescritos desde la perspectiva del cliente que escanea el QR
// y paga. El cliente NO tiene datáfono ni interactúa con uno — sólo paga
// desde su móvil. Los mensajes que le hablan de "datáfono" lo confunden.
const clientConfig: Record<PaymentStatus, StatusConfig> = {
  CREATED: {
    label: 'Listo para pagar',
    color: 'var(--np-text-mute)',
    bg: 'var(--np-pill-mute-bg)',
  },
  AWAITING_CAPTURE: {
    label: 'Pagando en datáfono',
    color: 'var(--np-text)',
    bg: 'var(--np-pill-mute-bg)',
    spin: true,
  },
  AUTHORIZING: {
    label: 'Procesando tu pago…',
    color: 'var(--np-text)',
    bg: 'var(--np-pill-mute-bg)',
    spin: true,
  },
  AUTHORIZED: {
    label: '¡Pagado! Gracias',
    color: 'var(--np-success)',
    bg: 'var(--np-pill-success-bg)',
  },
  FAILED: {
    label: 'No se pudo cobrar',
    color: 'var(--np-danger)',
    bg: 'var(--np-pill-danger-bg)',
  },
  EXPIRED: {
    label: 'El cobro ha caducado',
    color: 'var(--np-warning)',
    bg: 'var(--np-pill-warning-bg)',
  },
  CANCELED: {
    label: 'Cobro cancelado',
    color: 'var(--np-text-mute)',
    bg: 'var(--np-pill-mute-bg)',
  },
  REFUNDED: {
    label: 'Devuelto',
    color: 'var(--np-purple)',
    bg: 'var(--np-pill-purple-bg)',
  },
  PARTIALLY_REFUNDED: {
    label: 'Devuelto en parte',
    color: 'var(--np-purple)',
    bg: 'var(--np-pill-purple-bg)',
  },
  ORPHAN: {
    label: 'Verificando con el banco…',
    color: 'var(--np-warning)',
    bg: 'var(--np-pill-warning-bg)',
    spin: true,
  },
};

export function StatusPill({ status, size = 'md', perspective = 'operator' }: StatusPillProps) {
  const config = perspective === 'client' ? clientConfig : operatorConfig;
  // Defensive: si el backend introduce un status nuevo que la UI no conoce
  // (ej. tras un deploy parcial), fallback a un pill neutro en vez de crashear.
  const cfg = config[status] ?? {
    label: String(status),
    color: 'var(--np-text-mute)',
    bg: 'var(--np-pill-mute-bg)',
  };
  const dims =
    size === 'sm'
      ? { minHeight: '1.5rem', padding: '0 0.5rem', fontSize: '0.8125rem' }
      : { minHeight: '2rem', padding: '0 0.75rem 0 0.625rem', fontSize: '0.875rem' };

  return (
    <span
      role="status"
      aria-live="polite"
      style={{
        ...pillBase,
        ...dims,
        color: cfg.color,
        background: cfg.bg,
      } as CSSProperties}
    >
      {cfg.spin ? <Pulse color={cfg.color} /> : <Dot color={cfg.color} />}
      {cfg.label}
    </span>
  );
}

// Grafito: como los estados del panel y de «Cobros» del personal (fondo
// teñido, texto del color, radio de chip 6, 14/500, sin filete), con su punto
// (late mientras espera): el color nunca va solo.
const pillBase: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.5rem',
  borderRadius: 'var(--np-r-xs)',
  fontWeight: 500,
  lineHeight: 1.2,
  fontFamily: 'var(--np-font-sans)',
  transition: 'background var(--np-d-base), color var(--np-d-base)',
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
    </span>
  );
}
