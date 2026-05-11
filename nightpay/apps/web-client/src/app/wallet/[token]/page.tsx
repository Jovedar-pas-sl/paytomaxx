import { Card, Stage } from '@nightpay/ui';
import { fetchWalletByToken } from '@/lib/api';
import { WalletClient } from './WalletClient';

interface PageProps {
  params: { token: string };
}

export default async function WalletPage({ params }: PageProps) {
  const token = params.token;
  let wallet;
  try {
    wallet = await fetchWalletByToken(token);
  } catch {
    return (
      <Stage>
        <Card variant="glow" style={{ textAlign: 'center', maxWidth: '24rem' }}>
          <h1 style={{ fontSize: 'var(--np-t-h2)', margin: 0, fontWeight: 600, letterSpacing: '-0.02em' }}>
            Wallet no encontrada
          </h1>
          <p
            style={{
              color: 'var(--np-text-mute)',
              marginTop: '1rem',
              marginBottom: 0,
              fontSize: '0.95rem',
            }}
          >
            Recarga la página o pide ayuda al staff del local.
          </p>
        </Card>
      </Stage>
    );
  }

  return <WalletClient initial={wallet} token={token} />;
}
