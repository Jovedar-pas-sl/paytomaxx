'use client';

import type { ReactNode } from 'react';
import type { MyNight } from '@/lib/api';
import { formatEur } from '@/lib/money';
import { IconQr } from './icons';
import { ScreenHeader } from './ScreenHeader';
import styles from './cobrar.module.css';

interface Props {
  /** «Nerea · Compañera». */
  who: string;
  /** Su noche (null: aún no se sabe). */
  night: MyNight | null;
  /** La tarjeta de RRPP, como encima de la carta. */
  banner?: ReactNode;
  /** El logo abre el menú, como en la carta. */
  onLogo: () => void;
  onMiQr: () => void;
}

/**
 * La compañera con la casilla «Las compañeras cobran desde su móvil» apagada
 * en su local: en lugar de la carta, quién le cobra los servicios, su «Mi QR»
 * a un toque y lo que lleva esta noche. El menú del logo y la tarjeta de RRPP
 * siguen como en la carta.
 */
export function SinCobrar({ who, night, banner, onLogo, onMiQr }: Props) {
  return (
    <div className={styles.screen}>
      <ScreenHeader title="Hoy cobra el encargado" subtitle={who} onLogo={onLogo} />
      <div className={styles.body}>
        {banner}
        <p className={styles.muted}>
          Tus servicios los cobra el encargado (o recepción) escaneando tu «Mi QR». Lo tuyo te llega al momento a Ganancias.
        </p>
        <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onMiQr}>
          <IconQr />
          Mi QR
        </button>
        <p className={styles.muted}>
          Esta noche llevas <b className="np-num">{night ? formatEur(night.netCents, { compact: true }) : '—'}</b>
        </p>
      </div>
    </div>
  );
}
