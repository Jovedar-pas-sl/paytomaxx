'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { fetchApprovalRules, fetchApprovals, type ApprovalRules, type ApprovalView } from './api';
import { keepIfSame } from './diff';
import { usePolling } from './use-polling';

/** A las 4 de la mañana se aprueba desde el móvil: el globo se pone al día a menudo. */
const POLL_MS = 20_000;
const MAX_POLL_MS = 5 * 60_000;

export interface ApprovalsFeed {
  /** Qué le toca a quien mira (pedir o hacerlo directo); null mientras llega o si falla. */
  rules: ApprovalRules | null;
  /** Pendientes del local (solo el dueño; al encargado no se le pide nada). null = aún no han llegado. */
  pending: ApprovalView[] | null;
  error: string | null;
  refresh: () => void;
}

const EMPTY_FEED: ApprovalsFeed = { rules: null, pending: null, error: null, refresh: () => undefined };

export const ApprovalsContext = createContext<ApprovalsFeed>(EMPTY_FEED);

export function useApprovals(): ApprovalsFeed {
  return useContext(ApprovalsContext);
}

/**
 * «Por aprobar» para todo el panel: las reglas del local para quien mira (una
 * vez por local) y las pendientes (cada 20 s con el navegador a la vista; al
 * abrir la pestaña se refresca).
 */
export function useApprovalsFeed(user: { tenantId: string; role: string }): ApprovalsFeed {
  const [rules, setRules] = useState<ApprovalRules | null>(null);
  const [pending, setPending] = useState<ApprovalView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enabled = user.role === 'OWNER' || user.role === 'MANAGER';
  // El globo y la pestaña «Por aprobar» son del dueño: el encargado mira «Mis solicitudes».
  const isOwner = user.role === 'OWNER';

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setRules(null);
    fetchApprovalRules()
      .then((r) => {
        if (!cancelled) setRules(r);
      })
      .catch(() => {
        // Sin reglas el panel hace lo de siempre y el API decide (202 si hay que pedirlo).
      });
    return () => {
      cancelled = true;
    };
  }, [user.tenantId, enabled]);

  const refresh = usePolling(
    async (signal) => {
      try {
        const items = await fetchApprovals('PENDING');
        if (signal.aborted) return true;
        setPending((prev) => keepIfSame(prev, items));
        setError(null);
        return true;
      } catch (err) {
        if (!signal.aborted) setError((err as Error).message);
        return false;
      }
    },
    { intervalMs: POLL_MS, maxIntervalMs: MAX_POLL_MS, enabled: isOwner },
    [user.tenantId],
  );

  return useMemo(() => ({ rules, pending, error, refresh }), [rules, pending, error, refresh]);
}
