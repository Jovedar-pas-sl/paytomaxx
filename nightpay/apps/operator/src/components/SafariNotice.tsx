'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { useInstall } from '@nightpay/ui';
import { SAFARI_NOTICE_KEY, SAFARI_NOTICE_TEXT, safariNoticeDismissed, dismissSafariNotice, showSafariNotice } from '../lib/staff-install';
import styles from './safari-notice.module.css';

/**
 * La app instalada en un iPhone o un iPad: para cobrar con ficha o leer una
 * invitación con la cámara, que abra OxioPay en Safari. Es un aviso de algo
 * que no funciona en esa app (no una explicación de la pantalla): una línea
 * con «Entendido» que se queda cerrada en este móvil. En cualquier otro
 * móvil, nada.
 */
export function SafariNotice({ style }: { style?: CSSProperties }) {
  const { platform, apple } = useInstall();
  // null hasta leer lo guardado: así no parpadea en quien ya lo cerró.
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  useEffect(() => setDismissed(safariNoticeDismissed()), []);
  if (!showSafariNotice(platform, apple) || dismissed !== false) return null;
  return (
    <p className={styles.line} style={style}>
      {SAFARI_NOTICE_TEXT}{' '}
      <button
        type="button"
        className={styles.ok}
        data-storage-key={SAFARI_NOTICE_KEY}
        onClick={() => {
          dismissSafariNotice();
          setDismissed(true);
        }}
        aria-label="Entendido, ocultar el aviso"
      >
        Entendido
      </button>
    </p>
  );
}
