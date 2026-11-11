'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Input, ScreenHelp } from '@nightpay/ui';
import { checkPass, lookupCode, type SaldoRef } from '@/lib/api-cobro';
import { formatEur } from '@/lib/money';
import {
  NOT_A_PASS_TEXT,
  NO_BATTERY_TEXT,
  PASS_WITH_PHONE_CAMERA_TEXT,
  SIN_MOVIL_LABEL,
  pinProblemOf,
  scannedSaldo,
  walletCodeComplete,
  walletCodeInput,
  type PinVia,
} from '@/lib/sin-movil';
import { passCheckProblem } from '@/lib/wallet-pass';
import { QrScanner, qrScanSupported } from '../QrScanner';
import { TOURS } from '@/lib/tours';
import { ScreenHeader } from './ScreenHeader';
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
  /** Encontrado y con PIN: Esperando le pide su PIN. */
  onReady: (found: SaldoForPin) => void;
  onBack: () => void;
}

type Mode = 'menu' | 'code' | 'pass';

/**
 * «Sin móvil ni ficha» (lo que antes solo tenía «Saldo»): el cliente no saca
 * el móvil ni lleva ficha y paga ESTE cobro con su código (K7Q-4M2, tecleado
 * o leído del QR de la página de su saldo) o con el QR de su pase de Google
 * Wallet; después teclea su PIN aquí (la pantalla del PIN de siempre, la de
 * Esperando). Sin la cámara de la app (iPhone), se escanea con la del móvil:
 * la app se abre en otra pestaña y paga este cobro (el contexto de ficha que
 * guarda Esperando).
 */
export function SinMovil({ chargeId, amountCents, what, onReady, onBack }: Props) {
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
  // Viva mientras está montada. Se vuelve a marcar al montarse: React (modo
  // estricto) la monta, la desmonta y la monta otra vez, y sin esto se quedaba
  // en «Buscando…» con la respuesta ya llegada.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  function go(next: Mode) {
    setMode(next);
    setError(null);
  }

  /** Su saldo por su código (tecleado o leído del QR de su página): con PIN, a teclearlo; si no, por qué. */
  const byCode = useCallback(async (typed: string): Promise<boolean> => {
    const w = await lookupCode(typed);
    if (!alive.current) return false;
    const problem = pinProblemOf(w);
    if (problem) {
      setError(problem);
      return false;
    }
    ready.current({ ref: { code: w.code }, walletCode: w.code, via: 'code' });
    return true;
  }, []);

  async function findCode(e: FormEvent) {
    e.preventDefault();
    if (!walletCodeComplete(code) || busy) return;
    setBusy(true);
    setError(null);
    try {
      await byCode(code);
    } catch (err) {
      if (alive.current) setError((err as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const onScan = useCallback(
    async (raw: string) => {
      const scan = scannedSaldo(raw);
      if (scan.kind === 'unknown') {
        setError(NOT_A_PASS_TEXT);
        setScanRound((n) => n + 1);
        return;
      }
      setBusy(true);
      setError(null);
      let done = false;
      try {
        if (scan.kind === 'code') {
          done = await byCode(scan.code);
        } else {
          const check = await checkPass(chargeId, scan.token);
          if (!alive.current) return;
          const problem = passCheckProblem(check);
          if (problem) setError(problem);
          else ready.current({ ref: { walletToken: scan.token }, walletCode: check.codeHint, via: 'pass' });
          done = problem === null;
        }
      } catch (err) {
        if (alive.current) setError((err as Error).message);
      } finally {
        if (alive.current) {
          setBusy(false);
          // No ha valido: la cámara vuelve a leer (otra vuelta del escáner).
          if (!done) setScanRound((n) => n + 1);
        }
      }
    },
    [chargeId, byCode],
  );
  // Las dos, siempre la misma función: QrScanner no reinicia la cámara en cada render.
  const handleScan = useCallback((raw: string) => void onScan(raw), [onScan]);
  const onScanError = useCallback((message: string) => setError(message), []);

  const amount = formatEur(amountCents, { compact: true });
  return (
    <div className={styles.screen}>
      <ScreenHeader title={SIN_MOVIL_LABEL} subtitle={`${amount} · ${what}`} onBack={mode === 'menu' ? onBack : () => go('menu')} help={<ScreenHelp {...TOURS.sinMovil} ready={false} />} />
      <div className={styles.body}>
        {mode === 'menu' ? (
          <>
            <button type="button" className={`${styles.btn} ${styles.ghost} ${styles.altOpt}`} onClick={() => go('code')} data-tour="sinmovil-opciones">
              Su código + PIN
              <small>El código de su saldo (K7Q-4M2) y su PIN aquí</small>
            </button>
            <button type="button" className={`${styles.btn} ${styles.ghost} ${styles.altOpt}`} onClick={() => go('pass')}>
              Escanear su pase
              <small>El QR de su pase de Google Wallet (o el de su página del saldo) y su PIN aquí</small>
            </button>
            <p className={styles.altHint}>{NO_BATTERY_TEXT}</p>
          </>
        ) : null}
        {mode === 'code' ? (
          <form onSubmit={(e) => void findCode(e)} className={styles.altForm} data-tour="sinmovil-codigo">
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
              <p className={styles.altHint} data-tour="sinmovil-pase">Apunta al QR de su pase de Google Wallet o al de la página de su saldo.</p>
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
          <button type="button" className={styles.altLink} onClick={() => go('menu')} disabled={busy} data-tour="sinmovil-otra">
            Otra forma de pagar
          </button>
        ) : null}
      </div>
    </div>
  );
}
