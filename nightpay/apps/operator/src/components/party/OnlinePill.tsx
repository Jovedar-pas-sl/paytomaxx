'use client';

import { useOnline } from '@nightpay/ui';
import { useConnectionHealth } from '@/lib/connection-health';
import s from './party.module.css';

/**
 * «En línea» (maquetas de la barra y la taquilla): verde con internet y el
 * servidor respondiendo; si no, «Sin conexión» en ámbar (la franja de arriba
 * dice qué pasa). El color nunca va solo: el punto y la palabra.
 */
export function OnlinePill() {
  const online = useOnline();
  const health = useConnectionHealth();
  const ok = online && !health.serverDown;
  return (
    <span className={s.pill} data-ok={ok ? 'true' : 'false'} role="status">
      <i aria-hidden="true" />
      {ok ? 'En línea' : 'Sin conexión'}
    </span>
  );
}
