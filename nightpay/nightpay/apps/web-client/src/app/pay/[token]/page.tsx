import { Card, Stage } from '@nightpay/ui';
import { fetchPaymentByToken } from '@/lib/api';
import { PaymentClient } from './PaymentClient';

interface PageProps {
  params: { token: string };
}

export default async function PayPage({ params }: PageProps) {
  const token = params.token;
  let payment;
  try {
    payment = await fetchPaymentByToken(token);
  } catch {
    return (
      <Stage>
        <Card variant="glow" style={{ textAlign: 'center', maxWidth: '24rem' }}>
          <h1
            style={{
              fontSize: 'var(--np-t-h2)',
              margin: 0,
              fontWeight: 600,
              letterSpacing: '-0.02em',
            }}
          >
            QR no encontrado o expirado
          </h1>
          <p
            style={{
              color: 'var(--np-text-mute)',
              marginTop: '1rem',
              marginBottom: 0,
              fontSize: '0.95rem',
            }}
          >
            Pide al camarero que genere uno nuevo.
          </p>
        </Card>
      </Stage>
    );
  }

  return <PaymentClient initial={payment} token={token} />;
}
