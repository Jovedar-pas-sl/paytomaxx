'use client';

import type { CSSProperties } from 'react';
import { Card } from '@nightpay/ui';
import type { MyNight, OperatorBalance, OperatorUser } from '@/lib/api';
import { moneySummary } from '@/lib/earnings-view';
import { ROLE_LABEL } from '@/lib/roles';
import { staffHomeHint, useVenueMethods } from '@/lib/venue-methods';
import { CreatePayment } from './CreatePayment';
import styles from './home.module.css';
import { TonightCard } from './TonightCard';

interface Props {
  user: OperatorUser;
  /** La chica ve lo suyo de esta noche; camarero, encargado y dueño no tienen (el API da 403). */
  showBalance: boolean;
  balance: OperatorBalance | null;
  night: MyNight | null;
  onCobroDone: () => void;
  /** Tocar «Esta noche»: a Ganancias. */
  onOpenEarnings: () => void;
}

/** Inicio: arriba quién eres (y lo de esta noche, si eres la chica); debajo, cobrar. */
export function HomeTab({ user, showBalance, balance, night, onCobroDone, onOpenEarnings }: Props) {
  return (
    <div className={styles.home}>
      <div className={styles.intro}>
        {showBalance ? (
          <TonightCard
            compact
            who={user.displayName}
            night={night}
            summary={moneySummary(night, balance)}
            holdDays={null}
            onOpen={onOpenEarnings}
          />
        ) : (
          <StaffCard user={user} />
        )}
      </div>
      <CreatePayment role={user.role} onCreated={onCobroDone} />
    </div>
  );
}

function hello(user: OperatorUser): string {
  return `Hola${user.displayName ? `, ${user.displayName}` : ''}`;
}

/** Camarero, encargado o dueño: sin saldo propio; cobran (y, con datáfono, lo confirman). */
function StaffCard({ user }: { user: OperatorUser }) {
  const methods = useVenueMethods();
  return (
    <Card style={{ padding: 'calc(var(--np-pad-card) * 0.625) var(--np-pad-card)' }}>
      {/* Quién ha entrado, en una línea: debajo caben el teclado y las categorías. */}
      <p style={idLine}>
        <span style={kicker}>{ROLE_LABEL[user.role]}</span>
        <span style={{ fontSize: '1.25rem', fontWeight: 700 }}>{hello(user)}</span>
      </p>
      {/* En el móvil sobra (np-short-hide). */}
      <p className="np-short-hide" style={{ margin: '0.375rem 0 0', fontSize: '0.9375rem', color: 'var(--np-text-mute)' }}>
        {staffHomeHint(methods)}
      </p>
    </Card>
  );
}

const idLine: CSSProperties = {
  margin: 0,
  display: 'flex',
  alignItems: 'baseline',
  flexWrap: 'wrap',
  columnGap: '0.75rem',
  lineHeight: 1.3,
};

// Etiquetas pequeñas: mínimo 0.8125rem y el gris claro de etiquetas (11:1).
const kicker: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-label)',
  color: 'var(--np-text-label)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 600,
};
