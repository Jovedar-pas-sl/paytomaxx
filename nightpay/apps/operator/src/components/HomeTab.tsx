'use client';

import { useState } from 'react';
import type { MyNight, OperatorUser } from '@/lib/api';
import { isParty } from '@/lib/edition';
import { canTopUp, useMyRights } from '@/lib/venue-methods';
import { CobrarFlow } from './cobrar/CobrarFlow';
import { HomeTopUpDesk } from './reception/HomeTopUpDesk';
import { RrppHomeCard, useRrppUpcoming } from './rrpp/RrppHomeCard';
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
 * para que la inviten a una copa. Quien carga saldos (recepción, encargado,
 * dueño), «Recargar saldo» con las mismas pantallas que el mostrador de
 * Recepción (B12). En OxioParty, Inicio es la barra de la caseta: sin «Mi QR»
 * (no hay chicas) ni «Recargar saldo» (las pulseras se cargan en la Taquilla).
 */
export function HomeTab({ user, night, onCobroDone, onLogout }: Props) {
  const [miQr, setMiQr] = useState(false);
  const [recargar, setRecargar] = useState(false);
  const party = isParty();
  const rights = useMyRights();
  const topUps = !party && canTopUp(rights, user.role);
  // En OxioParty no hay RRPP (su panel no los da de alta): /staff/me/promoter da null y la tarjeta no sale.
  const rrppUpcoming = useRrppUpcoming();
  if (recargar && topUps) {
    return (
      <div className={styles.home}>
        <HomeTopUpDesk user={user} onExit={() => setRecargar(false)} onDone={onCobroDone} />
      </div>
    );
  }
  return (
    <div className={styles.home}>
      <CobrarFlow
        user={user}
        night={night}
        onCobroDone={onCobroDone}
        onLogout={onLogout}
        miQrOpen={miQr}
        onMiQr={user.role === 'OPERATOR' && !party ? setMiQr : undefined}
        onRecargar={topUps ? () => setRecargar(true) : undefined}
        banner={<RrppHomeCard upcoming={rrppUpcoming} />}
      />
    </div>
  );
}
