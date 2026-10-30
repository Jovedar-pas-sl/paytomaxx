'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Input } from '@nightpay/ui';
import { checkPass, lookupCode, type SaldoRef } from '@/lib/api-cobro';
import { formatEur } from '@/lib/money';
import {
  NOT_A_PASS_TEXT,
  NO_BATTERY_TEXT,
  PASS_WITH_PHONE_CAMERA_TEXT,
  SIN_MOVIL_LABEL,
  pinProblemOf,
  scannedPassToken,
  walletCodeComplete,
  walletCodeInput,
  type PinVia,
} from '@/lib/sin-movil';
import { passCheckProblem } from '@/lib/wallet-pass';
import { QrScanner, qrScanSupported } from '../QrScanner';
import { ScreenHeader, Stripe } from './ScreenHeader';
import styles from './cobrar.module.css';

/** El saldo con el que va a poner su PIN: de dónde salió y cómo se dice en la pantalla del PIN. */
export interface SaldoForPin {
  ref: SaldoRef;
  /** «K7Q-4M2» (su código) o «K7Q-•••» (su pase: no se enseña entero). */
  walletCode: string;
  via: PinVia;
}

interface Props {
  /** El cobro del saldo de este cobro (el que paga su PIN). */
  chargeId: string;
  /** Lo que paga (con la propina de la cuenta, si la hay). */
  amountCents: number;
  /** «2 copas». */
  what: string;
  /** La franja de la sección del cobro. */
  colors: ReadonlyArray<{ color: string; weight: number }>;
  /** Encontrado y con PIN: Esperando le pide su PIN. */
  onReady: (found: SaldoForPin) => void;
  onBack: () => void;
}

type Mode = 'menu' | 'code' | 'pass';

/**
 * «Sin móvil ni ficha» (lo que antes solo tenía «Saldo»): el cliente no saca
 * el móvil ni lleva ficha y paga ESTE cobro con su código (K7Q-4M2) o con el
 * QR de su pase de Google Wallet; después teclea su PIN aquí (la pantalla del
 * PIN de siempre, la de Esperando). Sin la cámara de la app (iPhone), su pase
 * se escanea con la del móvil: la app se abre en otra pestaña y paga este
 * cobro (el contexto de ficha que guarda Esperando).
 */
export function SinMovil({ chargeId, amountCents, what, colors, onReady, onBack }: Props) {
  const [mode, setMode] = useState<Mode>('menu');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Un QR que no era el del pase: la cámara vuelve a leer (otra vuelta del escáner).
  const [scanRound, setScanRound] = useState(0);
  const scanner = qrScanSupported();
  // La última onReady sin que la cámara se reinicie en cada render de Esperando.
  const ready = useRef(onReady);
  useEffect(() => {
    ready.current = onReady;
  });
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  function go(next: Mode) {
    setMode(next);
    setError(null);
  }

  async function findCode(e: FormEvent) {
    e.preventDefault();
    if (!walletCodeComplete(code) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const w = await lookupCode(code);
      if (!alive.current) return;
      const problem = pinProblemOf(w);
      if (problem) setError(problem);
      else ready.current({ ref: { code: w.code }, walletCode: w.code, via: 'code' });
    } catch (err) {
      if (alive.current) setError((err as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const onScan = useCallback(
    async (raw: string) => {
      const token = scannedPassToken(raw);
      if (!token) {
        setError(NOT_A_PASS_TEXT);
        setScanRound((n) => n + 1);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const check = await checkPass(chargeId, token);
        if (!alive.current) return;
        const problem = passCheckProblem(check);
        if (problem) {
          setError(problem);
          setScanRound((n) => n + 1);
        } else {
          ready.current({ ref: { walletToken: token }, walletCode: check.codeHint, via: 'pass' });
        }
      } catch (err) {
        if (!alive.current) return;
        setError((err as Error).message);
        setScanRound((n) => n + 1);
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [chargeId],
  );
  // Las dos, siempre la misma función: QrScanner no reinicia la cámara en cada render.
  const handleScan = useCallback((raw: string) => void onScan(raw), [onScan]);
  const onScanError = useCallback((message: string) => setError(message), []);

  const amount = formatEur(amountCents, { compact: true });
  return (
    <div className={styles.screen}>
      <ScreenHeader title={SIN_MOVIL_LABEL} subtitle={`${amount} · ${what}`} onBack={mode === 'menu' ? onBack : () => go('menu')} />
      <Stripe parts={colors} />
      <div className={styles.body}>
        {mode === 'menu' ? (
          <>
            <button type="button" className={`${styles.btn} ${styles.ghost} ${styles.altOpt}`} onClick={() => go('code')}>
              Su código + PIN
              <small>El código de su saldo (K7Q-4M2) y su PIN aquí</small>
            </button>
            <button type="button" className={`${styles.btn} ${styles.ghost} ${styles.altOpt}`} onClick={() => go('pass')}>
              Escanear su pase
              <small>El QR de su pase de Google Wallet y su PIN aquí</small>
            </button>
            <p className={styles.altHint}>{NO_BATTERY_TEXT}</p>
          </>
        ) : null}
        {mode === 'code' ? (
          <form onSubmit={(e) => void findCode(e)} className={styles.altForm}>
            <Input
              label="Código del cliente"
              value={code}
              onChange={(e) => setCode(walletCodeInput(e.target.value))}
              placeholder="K7Q-4M2"
              autoCapitalize="characters"
              autoComplete="off"
              autoFocus
              disabled={busy}
            />
            <button
              type="submit"
              className={`${styles.btn} ${styles.primary}`}
              disabled={busy || !walletCodeComplete(code)}
              aria-busy={busy}
            >
              {busy ? 'Buscando…' : 'Siguiente: su PIN'}
            </button>
          </form>
        ) : null}
        {mode === 'pass' ? (
          scanner ? (
            <>
              <p className={styles.altHint}>Apunta al QR de su pase de Google Wallet.</p>
              {busy ? (
                <p className={styles.altHint}>Comprobando el pase…</p>
              ) : (
                <QrScanner key={scanRound} onScan={handleScan} onError={onScanError} />
              )}
            </>
          ) : (
            <p className={styles.altHint}>{PASS_WITH_PHONE_CAMERA_TEXT}</p>
          )
        ) : null}
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
        {mode !== 'menu' ? (
          <button type="button" className={styles.altLink} onClick={() => go('menu')} disabled={busy}>
            Otra forma de pagar
          </button>
        ) : null}
      </div>
    </div>
  );
}
