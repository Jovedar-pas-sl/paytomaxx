import type { CSSProperties } from 'react';
import { Card, Stage } from '@nightpay/ui';

/** Enlace roto o mal copiado (también un token de QR con caracteres raros). */
export default function NotFound() {
  return (
    <Stage>
      <Card variant="glow" style={{ textAlign: 'center', maxWidth: '24rem' }}>
        <h1 style={titleStyle}>Este enlace no funciona</h1>
        <p style={textStyle}>Vuelve a escanear el QR o pide uno nuevo al personal del local.</p>
        <p style={textStyle} lang="en">
          This link does not work. Scan the QR code again or ask the venue staff for a new one.
        </p>
      </Card>
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
  margin: '1rem 0 0',
  color: 'var(--np-text-mute)',
  fontSize: '0.95rem',
};
