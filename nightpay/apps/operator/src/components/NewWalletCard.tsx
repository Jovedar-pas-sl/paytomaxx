'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button } from '@nightpay/ui';
import { fetchWalletById, setWalletPin, type WalletLookup } from '@/lib/api';
import { PinPad } from './PinPad';

/**
 * Recarga de un saldo ya cobrada: su código (el cliente le hace una foto o se
 * lo apunta) y las dos formas de pagar. Face ID lo activa en su móvil, en la
 * página donde pagó; el PIN, ahí mismo o aquí si pagó con el datáfono.
 */
export function NewWalletCard({ walletId }: { walletId: string }) {
  const [wallet, setWallet] = useState<WalletLookup | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchWalletById(walletId)
      .then(setWallet)
      .catch((err: Error) => setError(err.message));
  }, [walletId]);

  if (!wallet) return error ? <p style={errorStyle}>{error}</p> : null;

  if (choosing) {
    return (
      <PinPad
        mode="choose"
        title={`Saldo ${wallet.code}`}
        hint="Pásale el móvil al cliente para que elija su PIN"
        onCancel={() => setChoosing(false)}
        onPin={async (pin) => {
          setWallet(await setWalletPin(wallet.code, pin));
          setChoosing(false);
          return null;
        }}
      />
    );
  }

  return (
    <div style={boxStyle}>
      <p style={kicker}>Saldo del cliente</p>
      <p className="np-num" style={codeStyle}>
        {wallet.code}
      </p>
      <p style={hintStyle}>
        Que le haga una foto. Paga con su móvil (Face ID, lo activa en la página donde pagó) o sin sacarlo: con este
        código y su PIN.
      </p>
      {wallet.hasPin ? (
        <p style={okStyle}>✓ Ya tiene PIN</p>
      ) : (
        <Button variant="ghost" onClick={() => setChoosing(true)}>
          Que elija su PIN aquí
        </Button>
      )}
      {error ? <p style={errorStyle}>{error}</p> : null}
    </div>
  );
}

const boxStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.6rem',
  padding: '1rem',
  border: '2px solid var(--np-accent)',
  borderRadius: 'var(--np-r-lg)',
  textAlign: 'center',
};

const kicker: CSSProperties = {
  margin: 0,
  fontSize: '0.75rem',
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--np-text-mute)',
};

const codeStyle: CSSProperties = {
  margin: 0,
  fontSize: '2.25rem',
  fontWeight: 800,
  letterSpacing: '0.2em',
  color: 'var(--np-accent)',
};

const hintStyle: CSSProperties = { margin: 0, fontSize: '0.85rem', color: 'var(--np-text-mute)' };
const okStyle: CSSProperties = { margin: 0, fontWeight: 700, color: 'var(--np-success)' };
const errorStyle: CSSProperties = { margin: 0, fontSize: '0.9rem', color: 'var(--np-danger)' };
