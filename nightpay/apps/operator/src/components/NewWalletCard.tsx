'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button } from '@nightpay/ui';
import { walletCardUrl } from '@nightpay/contracts';
import { fetchWalletById, getUser, issueWalletCard, linkWalletCard, setWalletPin, type WalletLookup } from '@/lib/api';
import { saveFichaContext } from '@/lib/ficha-context';
import { nfcSupported, readCard } from '@/lib/nfc';
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
  const [nfc, setNfc] = useState(false);
  const [reading, setReading] = useState<AbortController | null>(null);
  const [iphoneHint, setIphoneHint] = useState(false);
  // Código para una ficha vacía: se pide una vez y se guarda hasta grabarlo
  // (antes uno nuevo en cada intento, aunque la ficha ya tuviera el suyo).
  const blankCode = useRef<Promise<string> | null>(null);

  useEffect(() => {
    setNfc(nfcSupported());
    fetchWalletById(walletId)
      .then(setWallet)
      .catch((err: Error) => setError(err.message));
  }, [walletId]);
  useEffect(() => () => reading?.abort(), [reading]);

  /** El código para grabar en una ficha vacía; si la petición falla, el siguiente intento pide otro. */
  function codeForBlankCard(): Promise<string> {
    if (!blankCode.current) {
      const request = issueWalletCard();
      // Con manejador: un fallo no queda como promesa rechazada sin atender.
      request.catch(() => {
        if (blankCode.current === request) blankCode.current = null;
      });
      blankCode.current = request;
    }
    return blankCode.current;
  }

  /** Android: lee la ficha; si está vacía, le graba su enlace; y se la da a este saldo. */
  async function giveCard(code: string) {
    const controller = new AbortController();
    setReading(controller);
    setError(null);
    try {
      // El código lo crea el servidor; se pide antes de acercarla (al grabar,
      // la ficha tiene que seguir ahí).
      const blank = codeForBlankCard();
      const read = await readCard(controller.signal);
      let token = read.token;
      if (!token) {
        token = await blank;
        await read.writeUrl(walletCardUrl(window.location.origin, token));
        blankCode.current = null; // ya está en la ficha
      }
      setWallet(await linkWalletCard(code, token, read.uid));
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      controller.abort();
      setReading(null);
    }
  }

  /** iPhone: la ficha (ya grabada) abre la app en otra pestaña, que se la da a este saldo. */
  function giveCardIphone(code: string) {
    const userId = getUser()?.id;
    if (!userId) return;
    saveFichaContext({ userId, kind: 'dar', code, at: Date.now() });
    setIphoneHint(true);
  }

  if (!wallet) {
    return error ? (
      <p role="alert" style={errorStyle}>
        {error}
      </p>
    ) : (
      <p style={hintStyle}>Cargando el saldo del cliente…</p>
    );
  }

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
      {wallet.hasCard ? (
        <p style={okStyle}>✓ Tiene ficha: la acerca y pone su PIN</p>
      ) : reading ? (
        <Button variant="ghost" onClick={() => reading.abort()}>
          Acerca la ficha a la parte de atrás del móvil… (cancelar)
        </Button>
      ) : nfc ? (
        <Button variant="ghost" onClick={() => void giveCard(wallet.code)}>
          Darle una ficha NFC
        </Button>
      ) : (
        <Button variant="ghost" onClick={() => giveCardIphone(wallet.code)}>
          Darle una ficha NFC
        </Button>
      )}
      {iphoneHint && !wallet.hasCard ? (
        <p style={hintStyle}>
          Acerca la ficha a la parte de arriba del iPhone y toca el aviso. (La ficha tiene que estar grabada antes, con un
          Android.)
        </p>
      ) : null}
      {error ? (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      ) : null}
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
  fontSize: 'var(--np-t-label)',
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
