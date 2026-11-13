'use client';

import { useEffect, useRef, type CSSProperties } from 'react';
import { PARTY_PAID_BACK_MS, type PaidRow } from '@/lib/party-barra';
import s from './party.module.css';

/** Las filas del detalle sobre el verde de PAGADO o CARGADO (maqueta): la etiqueta a la izquierda y el dato a la derecha. */
export function OutcomeRows({ rows }: { rows: readonly PaidRow[] }) {
  if (rows.length === 0) return null;
  return (
    <dl className={s.paidRows}>
      {rows.map((r) => (
        <div key={r.label} className={s.paidRow}>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * OxioParty · el detalle del PAGADO de la barra (maqueta «Pagado»): la
 * pulsera, lo que le queda y la hora (lo que el API dé) y, debajo, la barra
 * que avanza y «Vuelve sola a la carta en 3 s». Pasado ese tiempo, vuelve
 * sola; «Nuevo cobro» sigue para no esperar.
 */
export function PartyPaidDetail({ rows, onBack, backMs = PARTY_PAID_BACK_MS }: { rows: readonly PaidRow[]; onBack: () => void; backMs?: number }) {
  // La última función (la pantalla puede repintar) sin reiniciar la cuenta atrás.
  const back = useRef(onBack);
  useEffect(() => {
    back.current = onBack;
  });
  useEffect(() => {
    const timer = setTimeout(() => back.current(), backMs);
    return () => clearTimeout(timer);
  }, [backMs]);
  const seconds = Math.round(backMs / 1000);
  return (
    <>
      <OutcomeRows rows={rows} />
      <div className={s.back} style={{ '--back-ms': `${backMs}ms` } as CSSProperties}>
        <div className={s.backBar} aria-hidden="true">
          <i />
        </div>
        <p className={s.backText}>Vuelve sola a la carta en {seconds} s</p>
      </div>
    </>
  );
}
