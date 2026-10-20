'use client';

import { useState } from 'react';
import type { MyNight, OperatorUser } from '@/lib/api';
import { CobrarFlow } from './cobrar/CobrarFlow';
import styles from './home.module.css';

interface Props {
  user: OperatorUser;
  /** La noche de la chica (sus invitaciones, en «Mi QR»); null para el resto. */
  night: MyNight | null;
  onCobroDone: () => void;
  /** «Salir» (en el menú del logo: en Inicio la cabecera es la de «Cobrar»). */
  onLogout: () => void;
}

/**
 * Inicio = «Cobrar» (maquetas 1.1–3.4): la carta en losetas de su puesto, la
 * cuenta y el cobro único (QR y NFC a la vez). La chica, además, «Mi QR»
 * para que la inviten a una copa.
 */
export function HomeTab({ user, night, onCobroDone, onLogout }: Props) {
  const [miQr, setMiQr] = useState(false);
  return (
    <div className={styles.home}>
      <CobrarFlow
        user={user}
        night={night}
        onCobroDone={onCobroDone}
        onLogout={onLogout}
        miQrOpen={miQr}
        onMiQr={user.role === 'OPERATOR' ? setMiQr : undefined}
      />
    </div>
  );
}
