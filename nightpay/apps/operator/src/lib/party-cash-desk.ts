'use client';

// OxioParty · «Efectivo en esta caja» en la taquilla: lo que tiene que haber
// en la caja de quien carga, en la noche de ahora (GET /v1/party/cash-desk/me:
// recargas en efectivo menos el saldo devuelto en efectivo, sin el fondo).
// Es una ayuda, no un paso: si no llega (sin red, un API anterior, otro
// error), no se enseña y no se avisa de nada.

import { useEffect, useState } from 'react';
import type { PartyCashDesk } from '@nightpay/contracts';
import { authedFetch } from './api';
import { formatEur } from './money';

export const CASH_DESK_PATH = '/v1/party/cash-desk/me';

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

function isCashDesk(body: unknown): body is PartyCashDesk {
  if (!body || typeof body !== 'object') return false;
  const b = body as Partial<Record<keyof PartyCashDesk, unknown>>;
  return Number.isInteger(b.cashCents) && typeof b.overAlert === 'boolean';
}

/** La caja de quien carga; null si no se puede saber (el error no se enseña). */
export async function loadCashDesk(fetcher: Fetcher, signal?: AbortSignal): Promise<PartyCashDesk | null> {
  try {
    const res = await fetcher(CASH_DESK_PATH, signal ? { signal } : {});
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isCashDesk(body) ? body : null;
  } catch {
    return null;
  }
}

export interface CashDeskLine {
  /** «1.240,00 €» */
  value: string;
  /** Pasa del aviso de efectivo del organizador. */
  over: boolean;
}

/** La línea de la taquilla; null: no se enseña. */
export function cashDeskLine(desk: PartyCashDesk | null): CashDeskLine | null {
  if (!desk) return null;
  return { value: formatEur(desk.cashCents), over: desk.overAlert };
}

/**
 * La caja de quien carga, pedida al abrir y cada vez que cambia `refreshKey`
 * (después de cada carga). Apagado (`enabled` false, OxioPay): no pide nada.
 */
export function useCashDesk(enabled: boolean, refreshKey: number): PartyCashDesk | null {
  const [desk, setDesk] = useState<PartyCashDesk | null>(null);
  useEffect(() => {
    if (!enabled) {
      setDesk(null);
      return;
    }
    const ctrl = new AbortController();
    void loadCashDesk(authedFetch, ctrl.signal).then((next) => {
      if (!ctrl.signal.aborted) setDesk(next);
    });
    return () => ctrl.abort();
  }, [enabled, refreshKey]);
  return desk;
}
