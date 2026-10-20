'use client';

import type { CSSProperties } from 'react';
import {
  classifyConnection,
  ConnectionBanner,
  SERVER_DOWN_GRACE_MS,
  useDelayedFlag,
  useNow,
  useOnline,
} from '@nightpay/ui';
import { useConnectionHealth } from '@/lib/connection-health';

interface Props {
  /** Otra señal de API caído que no pasa por las pantallas de cobro (el saldo que se refresca solo). */
  serverDown?: boolean;
}

/**
 * La franja ámbar de arriba con lo que falla: sin internet, OxioPay sin
 * responder o el banco tardando. Sustituye al «Reconectando…» de cada cobro.
 */
export function ConnectionStatus({ serverDown = false }: Props) {
  const online = useOnline();
  const health = useConnectionHealth();
  // Un corte de un segundo (el socket reconectando) no merece aviso.
  const down = useDelayedFlag(serverDown || health.serverDown, SERVER_DOWN_GRACE_MS);
  // La hora solo hace falta para saber cuánto lleva esperando al banco.
  const now = useNow(health.bankWaitingSinceMs !== null);
  const issue = classifyConnection(
    { online, serverDown: down, bankWaitingSinceMs: health.bankWaitingSinceMs, orphan: health.orphan },
    now,
    'phone',
  );
  return <ConnectionBanner issue={issue} style={bleed} />;
}

// De borde a borde, saliendo del padding de la página (arriba --np-gap, a los lados 1rem).
const bleed: CSSProperties = { margin: 'calc(-1 * var(--np-gap)) -1rem 0' };
