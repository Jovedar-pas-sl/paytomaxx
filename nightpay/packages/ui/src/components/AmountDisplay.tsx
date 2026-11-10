import type { CSSProperties } from 'react';
import { formatMoney } from '@nightpay/contracts';
import type { PaymentStatus } from './StatusPill';

interface AmountDisplayProps {
  amountCents: number;
  currency: string;
  status?: PaymentStatus;
}

/**
 * El importe del cobro abierto (TPV), como el del resultado (Grafito): una
 * sola cifra «25,00 €» en Manrope 600 proporcional, sin halo ni trozos de
 * tamaños distintos. Esperando al banco, late despacio (< 1 Hz); pagado en
 * verde y rechazado o caducado en rojo (con su estado al lado: nunca solo el
 * color). La letra baja para que quepa en una línea (--np-fit).
 */
export function AmountDisplay({ amountCents, currency, status = 'CREATED' }: AmountDisplayProps) {
  // El formato de toda la app: «25,00 €»; miles con punto.
  const text = formatMoney(amountCents, { currency });

  const isAuthorizing = status === 'AUTHORIZING' || status === 'ORPHAN';
  const isFinal = status === 'AUTHORIZED';
  const isFailed = status === 'FAILED' || status === 'EXPIRED';

  const color = isFinal ? 'var(--np-success)' : isFailed ? 'var(--np-danger)' : 'var(--np-text)';

  return (
    <div data-status={status} style={wrap}>
      <span
        className="np-num"
        style={
          {
            ...amountStyle,
            '--np-fit': Math.max(4, text.length * 0.58).toFixed(2),
            color,
            animation: isAuthorizing ? 'np-amount-breathe var(--np-pulse) ease-in-out infinite' : 'none',
          } as CSSProperties
        }
      >
        {text}
      </span>
    </div>
  );
}

// El ancho de la tarjeta manda (cqi): en el móvil y en la tableta cabe igual.
const wrap: CSSProperties = {
  containerType: 'inline-size',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 'var(--np-s-5) 0',
};

const amountStyle: CSSProperties = {
  display: 'block',
  fontWeight: 600,
  lineHeight: 1.05,
  letterSpacing: 0,
  fontVariantNumeric: 'proportional-nums',
  fontFeatureSettings: 'normal',
  whiteSpace: 'nowrap',
  fontSize: 'min(var(--np-t-amount), calc(92cqi / var(--np-fit, 6)))',
  transition: 'color var(--np-d-base)',
};
