'use client';

import type { CSSProperties } from 'react';
import { Card } from '@nightpay/ui';
import type { MyNight, OperatorBalance, OperatorUser } from '@/lib/api';
import { moneySummary } from '@/lib/earnings-view';
import { ROLE_LABEL } from '@/lib/roles';
import { CreatePayment } from './CreatePayment';
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', flex: 1 }}>
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
      <CreatePayment role={user.role} onCreated={onCobroDone} />
    </div>
  );
}

function hello(user: OperatorUser): string {
  return `Hola${user.displayName ? `, ${user.displayName}` : ''}`;
}

/** Camarero, encargado o dueño: sin saldo propio; cobran y confirman el datáfono. */
function StaffCard({ user }: { user: OperatorUser }) {
  return (
    <Card style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      <p style={kicker}>{ROLE_LABEL[user.role]}</p>
      <p style={{ margin: 0, fontSize: '1.375rem', fontWeight: 700 }}>{hello(user)}</p>
      <p style={{ margin: 0, fontSize: '0.9375rem', color: 'var(--np-text-mute)' }}>
        Cobra aquí la barra, las habitaciones o la comida. Los cobros con datáfono que crean las chicas te esperan en
        «POS».
      </p>
    </Card>
  );
}

// Etiquetas pequeñas: mínimo 0.8125rem y el gris claro de etiquetas (11:1).
const kicker: CSSProperties = {
  margin: '0 0 0.25rem',
  fontSize: 'var(--np-t-label)',
  color: 'var(--np-text-label)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 600,
};
