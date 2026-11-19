'use client';

import { useEffect, useState } from 'react';
import type { PayoutAccountNotice } from '@nightpay/contracts';
import { fetchPayoutNotice, markPayoutNoticeSeen, payoutNoticeText } from '../lib/payout-notice';
import styles from './payout-change-notice.module.css';

/**
 * Al entrar en la app: «Tu cuenta de cobro ha cambiado», con cuándo y a dónde
 * le pagan ahora (tapada) y qué hacer si no ha sido ella. Sale hasta que
 * pulsa «Entendido» (queda apuntado en el servidor: no vuelve en otro móvil).
 */
export function PayoutChangeNotice({ hidden = false }: { /** Con un cobro abierto no se enseña (se pregunta una vez, al entrar). */ hidden?: boolean }) {
  const [notice, setNotice] = useState<PayoutAccountNotice | null>(null);

  useEffect(() => {
    let alive = true;
    // Si no se puede preguntar ahora, saldrá la próxima vez que entre.
    fetchPayoutNotice()
      .then((n) => alive && setNotice(n))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!notice || hidden) return null;
  const text = payoutNoticeText(notice);
  return (
    <section className={styles.box} role="alert" aria-label={text.title}>
      <h2 className={styles.title}>{text.title}</h2>
      <p className={styles.line}>
        {text.when} {text.now}
      </p>
      <p className={styles.line}>{text.advice}</p>
      <button
        type="button"
        className={styles.ok}
        onClick={() => {
          // Se quita ya; si el servidor no lo apunta, volverá a salir al entrar.
          setNotice(null);
          void markPayoutNoticeSeen().catch(() => undefined);
        }}
      >
        Entendido
      </button>
    </section>
  );
}
