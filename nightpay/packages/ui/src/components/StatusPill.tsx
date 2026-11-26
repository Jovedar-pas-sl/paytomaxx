import { Etiqueta, type EtiquetaTone } from './Etiqueta';

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
  /** El tono de la Etiqueta: su color, su fondo y su símbolo. */
  tone: EtiquetaTone;
  /** Mientras espera: el punto que late en lugar del símbolo. */
  spin?: boolean;
}

const operatorConfig: Record<PaymentStatus, StatusConfig> = {
  CREATED: {
    label: 'Esperando confirmación',
    tone: 'neutral',
  },
  AWAITING_CAPTURE: {
    label: 'Esperando datáfono',
    tone: 'neutral',
  },
  AUTHORIZING: {
    // Vale para QR (cliente en la página del banco) y para datáfono. En
    // neutro con el punto que late: el lima es para la acción y el «pagado».
    label: 'Esperando pago',
    tone: 'wait',
    spin: true,
  },
  AUTHORIZED: {
    label: 'Pago completado',
    tone: 'success',
  },
  FAILED: {
    label: 'Pago rechazado',
    tone: 'danger',
  },
  EXPIRED: {
    label: 'QR expirado',
    tone: 'warning',
  },
  CANCELED: {
    label: 'Cancelado',
    tone: 'neutral',
  },
  REFUNDED: {
    label: 'Reembolsado',
    tone: 'refund',
  },
  PARTIALLY_REFUNDED: {
    label: 'Reembolso parcial',
    tone: 'refund',
  },
  // ORPHAN = el banco no confirmó a tiempo. No gira: no se resuelve solo,
  // hay que mirarlo en el banco.
  ORPHAN: {
    label: 'Sin confirmar',
    tone: 'warning',
  },
};

// Labels reescritos desde la perspectiva del cliente que escanea el QR
// y paga. El cliente NO tiene datáfono ni interactúa con uno — sólo paga
// desde su móvil. Los mensajes que le hablan de "datáfono" lo confunden.
const clientConfig: Record<PaymentStatus, StatusConfig> = {
  CREATED: {
    label: 'Listo para pagar',
    tone: 'neutral',
  },
  AWAITING_CAPTURE: {
    label: 'Pagando en datáfono',
    tone: 'wait',
    spin: true,
  },
  AUTHORIZING: {
    label: 'Procesando tu pago…',
    tone: 'wait',
    spin: true,
  },
  AUTHORIZED: {
    label: '¡Pagado! Gracias',
    tone: 'success',
  },
  FAILED: {
    label: 'No se pudo cobrar',
    tone: 'danger',
  },
  EXPIRED: {
    label: 'El cobro ha caducado',
    tone: 'warning',
  },
  CANCELED: {
    label: 'Cobro cancelado',
    tone: 'neutral',
  },
  REFUNDED: {
    label: 'Devuelto',
    tone: 'refund',
  },
  PARTIALLY_REFUNDED: {
    label: 'Devuelto en parte',
    tone: 'refund',
  },
  ORPHAN: {
    label: 'Verificando con el banco…',
    tone: 'warning',
    spin: true,
  },
};

/**
 * El estado de un cobro: una Etiqueta de estado (símbolo + palabra, el color
 * nunca va solo), con su punto que late mientras espera. Se anuncia al cambiar.
 */
export function StatusPill({ status, size = 'md', perspective = 'operator' }: StatusPillProps) {
  const config = perspective === 'client' ? clientConfig : operatorConfig;
  // Defensive: si el backend introduce un status nuevo que la UI no conoce
  // (ej. tras un deploy parcial), fallback a un pill neutro en vez de crashear.
  const cfg: StatusConfig = config[status] ?? { label: String(status), tone: 'neutral' };
  return (
    <Etiqueta tone={cfg.tone} pulse={cfg.spin} size={size} role="status" aria-live="polite">
      {cfg.label}
    </Etiqueta>
  );
}
