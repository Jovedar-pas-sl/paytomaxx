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
      <main style={pageStyle}>
        <h1 style={titleStyle}>QR no encontrado o expirado</h1>
        <p style={{ color: '#999', marginTop: '1rem' }}>
          Pide al camarero que genere uno nuevo.
        </p>
      </main>
    );
  }

  return <PaymentClient initial={payment} token={token} />;
}

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '2rem',
  textAlign: 'center',
};

const titleStyle: React.CSSProperties = {
  fontSize: '1.75rem',
  margin: 0,
};
