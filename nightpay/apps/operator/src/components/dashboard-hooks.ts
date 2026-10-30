import { useCallback, useEffect, useState } from 'react';
import { isPassChargeToken, isWalletCardToken, WALLET_CARD_PARAM, WALLET_PASS_PARAM } from '@nightpay/contracts';
import {
  fetchBalance,
  fetchMyNight,
  pollErrorText,
  ServerUnavailableError,
  SessionExpiredError,
  type MyNight,
  type OperatorBalance,
} from '@/lib/api';
import { walletCodeFromText } from '@/lib/sin-movil';
import { usePolling } from '@/lib/use-polling';

const BALANCE_POLL_MS = 8000;
/**
 * La noche cuesta más al API (suma la noche entera): menos a menudo, y ya
 * tras cada cobro. Cada 15 s: «Te han invitado · +10 €» llega enseguida.
 */
const NIGHT_POLL_MS = 15_000;

export interface PollError {
  text: string;
  /** Servidor caído o saturado: se reintenta solo (aviso, no error). */
  transient: boolean;
}

export interface OwnBalance {
  balance: OperatorBalance | null;
  error: PollError | null;
  /** Refrescar ya (tras un cobro). Siempre la misma función: no reinicia nada al pasarla. */
  refresh: () => void;
}

/** El saldo de la chica, cada 8 s. Solo si `enabled` (los demás roles no tienen). */
export function useOwnBalance(enabled: boolean): OwnBalance {
  const [balance, setBalance] = useState<OperatorBalance | null>(null);
  const [error, setError] = useState<PollError | null>(null);
  const refresh = usePolling(
    async (signal) => {
      try {
        setBalance(await fetchBalance(signal));
        setError(null);
      } catch (err) {
        if (signal.aborted) return 'slow';
        setError({ text: pollErrorText(err), transient: err instanceof ServerUnavailableError });
        return err instanceof SessionExpiredError ? 'stop' : 'slow';
      }
    },
    { intervalMs: BALANCE_POLL_MS, enabled },
  );
  return { balance, error, refresh };
}

export interface OwnNight {
  night: MyNight | null;
  /** No se pudo cargar (el servidor caído ya lo dice la franja de arriba). */
  error: string | null;
  refresh: () => void;
}

/** «Esta noche» de la chica, cada 30 s y al pedirlo (tras un cobro). Solo si `enabled`. */
export function useMyNight(enabled: boolean): OwnNight {
  const [night, setNight] = useState<MyNight | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = usePolling(
    async (signal) => {
      try {
        setNight(await fetchMyNight(signal));
        setError(null);
      } catch (err) {
        if (signal.aborted) return 'slow';
        setError(err instanceof ServerUnavailableError ? null : pollErrorText(err));
        return err instanceof SessionExpiredError ? 'stop' : 'slow';
      }
    },
    { intervalMs: NIGHT_POLL_MS, enabled },
  );
  return { night, error, refresh };
}

export interface DeepLinks {
  /** ?pos=<id>: el camarero escaneó el QR de un cobro con datáfono. */
  focusedPosId: string | null;
  /** Ya se abrió ese cobro: "← Lista" no lo vuelve a abrir. */
  clearFocus: () => void;
  /** ?ficha=<código>: ficha NFC acercada a un iPhone. */
  ficha: string | null;
  clearFicha: () => void;
  /** ?pase=<token>: el QR del pase de Google Wallet del cliente, leído con la cámara del móvil. */
  pass: string | null;
  clearPass: () => void;
  /** ?saldo=<código>: el QR de la página del saldo del cliente (solo su código), leído con la cámara del móvil. */
  code: string | null;
  clearCode: () => void;
}

/** El parámetro del QR de la página del saldo del cliente (API: wallet-rules.walletCodeQrContent). */
export const WALLET_CODE_PARAM = 'saldo';

/** Lee los enlaces con los que se abrió la app y los quita de la URL (un refresh no los repite). */
export function useDeepLinks(acceptsPos: boolean): DeepLinks {
  const [focusedPosId, setFocusedPosId] = useState<string | null>(null);
  const [ficha, setFicha] = useState<string | null>(null);
  const [pass, setPass] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const posId = url.searchParams.get('pos');
    if (posId && acceptsPos) setFocusedPosId(posId);
    const card = url.searchParams.get(WALLET_CARD_PARAM) ?? '';
    if (isWalletCardToken(card)) setFicha(card);
    const passToken = url.searchParams.get(WALLET_PASS_PARAM) ?? '';
    if (isPassChargeToken(passToken)) setPass(passToken);
    // Solo su código (6 letras o cifras): con el cobro abierto en Inicio, su PIN aquí.
    const walletCode = url.searchParams.has(WALLET_CODE_PARAM) ? walletCodeFromText(url.toString()) : null;
    if (walletCode) setCode(walletCode);
    url.searchParams.delete('pos');
    url.searchParams.delete(WALLET_CARD_PARAM);
    url.searchParams.delete(WALLET_PASS_PARAM);
    url.searchParams.delete(WALLET_CODE_PARAM);
    if (url.toString() !== window.location.href) window.history.replaceState({}, '', url.toString());
  }, [acceptsPos]);

  const clearFocus = useCallback(() => setFocusedPosId(null), []);
  const clearFicha = useCallback(() => setFicha(null), []);
  const clearPass = useCallback(() => setPass(null), []);
  const clearCode = useCallback(() => setCode(null), []);
  return { focusedPosId, clearFocus, ficha, clearFicha, pass, clearPass, code, clearCode };
}
