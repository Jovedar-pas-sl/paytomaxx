'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Button, FormError, Icon } from '@nightpay/ui';
import { walletCardUrl } from '@nightpay/contracts';
import { fetchWalletById, getUser, issueWalletCard, linkWalletCard, setWalletPin, type WalletLookup } from '@/lib/api';
import { blankCodeFrom, tapChip } from '@/lib/chip-tap';
import { saveFichaContext } from '@/lib/ficha-context';
import { fichaPlace, useReaderSpot } from '@/lib/lector-nfc';
import { nfcSupported } from '@/lib/nfc';
import { SkelCard } from './loading-shapes';
import { PinPad } from './PinPad';

/**
 * Recarga de un saldo ya cobrada: su código (el cliente le hace una foto o se
 * lo apunta) y las dos formas de pagar. Face ID lo activa en su móvil, en la
 * página donde pagó; el PIN, ahí mismo o aquí si pagó con el datáfono.
 * `withCard`: ofrecer darle una ficha NFC (apagado si el local no usa fichas).
 */
export function NewWalletCard({ walletId, withCard = true }: { walletId: string; withCard?: boolean }) {
  const [wallet, setWallet] = useState<WalletLookup | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nfc, setNfc] = useState(false);
  const [reading, setReading] = useState<AbortController | null>(null);
  const [iphoneHint, setIphoneHint] = useState(false);
  const readerSpot = useReaderSpot();
  // Código para una ficha vacía: se pide una vez y se guarda hasta intentar grabarlo.
  const blank = useMemo(() => blankCodeFrom(issueWalletCard, (token) => walletCardUrl(window.location.origin, token)), []);

  useEffect(() => {
    setNfc(nfcSupported());
    fetchWalletById(walletId)
      .then(setWallet)
      .catch((err: Error) => setError(err.message));
  }, [walletId]);
  useEffect(() => () => reading?.abort(), [reading]);

  /**
   * Android: lee la ficha; si está en blanco, le graba su enlace (sin pisar
   * nada) y la vuelve a leer; y se la da a este saldo. Una ficha con otra cosa
   * grabada no se toca.
   */
  async function giveCard(code: string) {
    const controller = new AbortController();
    setReading(controller);
    setError(null);
    try {
      const tap = await tapChip('web', controller.signal, blank);
      if (tap.other) throw new Error('Esta ficha tiene otra cosa grabada: usa otra.');
      if (!tap.token) throw new Error('No se ha podido leer la ficha: acércala otra vez.');
      setWallet(await linkWalletCard(code, tap.token, tap.uid));
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
      <FormError>{error}</FormError>
    ) : (
      <SkelCard figure lines={1} style={boxStyle} />
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
        <p style={okStyle}>
          <Icon name="check" size={20} className="np-icon-lead" />
          Ya tiene PIN
        </p>
      ) : (
        <Button variant="ghost" onClick={() => setChoosing(true)}>
          Que elija su PIN aquí
        </Button>
      )}
      {!withCard ? null : wallet.hasCard ? (
        <p style={okStyle}>
          <Icon name="check" size={20} className="np-icon-lead" />
          Tiene ficha: la acerca y pone su PIN
        </p>
      ) : reading ? (
        <Button variant="ghost" onClick={() => reading.abort()}>
          Acerca la ficha {fichaPlace(readerSpot, 'móvil')}… (cancelar)
        </Button>
      ) : nfc ? (
        <Button variant="ghost" onClick={() => void giveCard(wallet.code)}>
          Darle una ficha
        </Button>
      ) : (
        <Button variant="ghost" onClick={() => giveCardIphone(wallet.code)}>
          Darle una ficha
        </Button>
      )}
      {withCard && iphoneHint && !wallet.hasCard ? (
        <p style={hintStyle}>
          Acerca la ficha a la parte de arriba del iPhone y toca el aviso. (La ficha tiene que estar grabada antes, con un
          Android.)
        </p>
      ) : null}
      {error ? <FormError>{error}</FormError> : null}
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
  fontWeight: 600,
  color: 'var(--np-text-mute)',
};

const codeStyle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-fs-40)',
  fontWeight: 700,
  letterSpacing: '0.2em',
  color: 'var(--np-text)',
};

const hintStyle: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-14)', color: 'var(--np-text-mute)' };
const okStyle: CSSProperties = { margin: 0, fontWeight: 600, color: 'var(--np-success)' };
