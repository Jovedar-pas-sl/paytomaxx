import { useCallback, useEffect, useState } from 'react';
import { isWalletCardToken, WALLET_CARD_PARAM } from '@nightpay/contracts';
import {
  fetchBalance,
  pollErrorText,
  ServerUnavailableError,
  SessionExpiredError,
  type OperatorBalance,
} from '@/lib/api';
import { usePolling } from '@/lib/use-polling';

const BALANCE_POLL_MS = 8000;

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

export interface DeepLinks {
  /** ?pos=<id>: el camarero escaneó el QR de un cobro con datáfono. */
  focusedPosId: string | null;
  /** Ya se abrió ese cobro: "← Lista" no lo vuelve a abrir. */
  clearFocus: () => void;
  /** ?ficha=<código>: ficha NFC acercada a un iPhone. */
  ficha: string | null;
  clearFicha: () => void;
}

/** Lee los enlaces con los que se abrió la app y los quita de la URL (un refresh no los repite). */
export function useDeepLinks(acceptsPos: boolean): DeepLinks {
  const [focusedPosId, setFocusedPosId] = useState<string | null>(null);
  const [ficha, setFicha] = useState<string | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const posId = url.searchParams.get('pos');
    if (posId && acceptsPos) setFocusedPosId(posId);
    const card = url.searchParams.get(WALLET_CARD_PARAM) ?? '';
    if (isWalletCardToken(card)) setFicha(card);
    url.searchParams.delete('pos');
    url.searchParams.delete(WALLET_CARD_PARAM);
    if (url.toString() !== window.location.href) window.history.replaceState({}, '', url.toString());
  }, [acceptsPos]);

  const clearFocus = useCallback(() => setFocusedPosId(null), []);
  const clearFicha = useCallback(() => setFicha(null), []);
  return { focusedPosId, clearFocus, ficha, clearFicha };
}
