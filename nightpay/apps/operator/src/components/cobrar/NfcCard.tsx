'use client';

import styles from './cobrar.module.css';

/**
 * La tarjeta NFC (maqueta «ncard»): plata con el halo lima, como la OxioCard.
 * Dice dónde se acerca el NFC (tarjeta, ficha o pulsera, da igual).
 */
export function NfcCard({ reading = false }: { reading?: boolean }) {
  return (
    <span className={`${styles.ncard}${reading ? ` ${styles.ncardReading}` : ''}`} aria-hidden="true">
      <img className={styles.ncardLogo} src="/brand/oxiocard-simbolo.png" alt="" width={49} height={49} />
      <i className={styles.ncardTri} />
      <svg className={styles.ncardWaves} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
        <path d="M5.5 10.5a2 2 0 0 1 0 3" />
        <path d="M9 8a6 6 0 0 1 0 8" />
        <path d="M12.5 5.5a9.5 9.5 0 0 1 0 13" />
        <path d="M16 3a13 13 0 0 1 0 18" />
      </svg>
    </span>
  );
}
