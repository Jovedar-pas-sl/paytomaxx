import type { CSSProperties } from 'react';
import { Logo, Stage } from '@nightpay/ui';

/** Portada: al pago y al saldo se llega con el enlace del QR, no desde aquí. */
export default function HomePage() {
  return (
    <Stage>
      <Logo height="2.5rem" />
      <h1 style={titleStyle}>OxioPay</h1>
      <p style={textStyle}>Para pagar, escanea el QR que te enseña el personal del local.</p>
    </Stage>
  );
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-h2)',
  fontWeight: 600,
  letterSpacing: '-0.02em',
};

const textStyle: CSSProperties = {
  margin: 0,
  maxWidth: '24rem',
  textAlign: 'center',
  color: 'var(--np-text-mute)',
};
