'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button } from '@nightpay/ui';
import { assignWalletTag, fetchWalletById, setWalletPin, type WalletLookup } from '@/lib/api';
import { nfcAvailable, readNfcTag } from '@/lib/nfc';
import { PinPad } from './PinPad';

/**
 * Recarga de un saldo nuevo ya cobrada: su código (el cliente le hace una foto
 * o se lo apunta), su PIN si aún no lo eligió en su móvil, y la pulsera NFC.
 */
export function NewWalletCard({ walletId }: { walletId: string }) {
  const [wallet, setWallet] = useState<WalletLookup | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [tagging, setTagging] = useState<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canNfc, setCanNfc] = useState(false);

  useEffect(() => {
    setCanNfc(nfcAvailable());
    fetchWalletById(walletId)
      .then(setWallet)
      .catch((err: Error) => setError(err.message));
  }, [walletId]);
  useEffect(() => () => tagging?.abort(), [tagging]);

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

  async function assignTag(code: string) {
    const controller = new AbortController();
    setTagging(controller);
    setError(null);
    try {
      setWallet(await assignWalletTag(code, await readNfcTag(controller.signal)));
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      setTagging(null);
    }
  }

  return (
    <div style={boxStyle}>
      <p style={kicker}>Saldo del cliente</p>
      <p className="np-num" style={codeStyle}>
        {wallet.code}
      </p>
      <p style={hintStyle}>Que le haga una foto o apúntaselo: con este código (o su pulsera) y su PIN paga con el saldo.</p>
      {wallet.hasPin ? (
        <p style={okStyle}>✓ Ya tiene PIN</p>
      ) : (
        <>
          <p style={hintStyle}>
            Puede elegir su PIN en su móvil, en la página donde pagó. Si no lo tiene a mano, que lo elija aquí:
          </p>
          <Button variant="ghost" onClick={() => setChoosing(true)}>
            Que elija su PIN aquí
          </Button>
        </>
      )}
      {canNfc && !wallet.hasTag ? (
        tagging ? (
          <Button variant="ghost" onClick={() => tagging.abort()}>
            Acerca la pulsera… (cancelar)
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => void assignTag(wallet.code)}>
            Asignar pulsera NFC
          </Button>
        )
      ) : null}
      {wallet.hasTag ? <p style={okStyle}>✓ Pulsera asignada</p> : null}
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
