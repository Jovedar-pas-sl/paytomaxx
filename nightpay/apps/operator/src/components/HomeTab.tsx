'use client';

import type { CSSProperties } from 'react';
import { Card } from '@nightpay/ui';
import type { OperatorBalance, OperatorUser } from '@/lib/api';
import { formatEur, formatEurAmount } from '@/lib/money';
import { ROLE_LABEL } from '@/lib/roles';
import { CreatePayment } from './CreatePayment';

interface Props {
  user: OperatorUser;
  /** La chica ve su saldo; camarero, encargado y dueño no tienen (el API da 403). */
  showBalance: boolean;
  balance: OperatorBalance | null;
  onCobroDone: () => void;
}

/** Inicio: arriba quién eres (y tu saldo, si eres la chica); debajo, cobrar. */
export function HomeTab({ user, showBalance, balance, onCobroDone }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', flex: 1 }}>
      {showBalance ? <BalanceCard user={user} balance={balance} /> : <StaffCard user={user} />}
      <CreatePayment role={user.role} onCreated={onCobroDone} />
    </div>
  );
}

function hello(user: OperatorUser): string {
  return `Hola${user.displayName ? `, ${user.displayName}` : ''}`;
}

function BalanceCard({ user, balance }: { user: OperatorUser; balance: OperatorBalance | null }) {
  const negative = balance ? balance.pendingCents < 0 : false;
  return (
    <Card variant="glow" style={{ padding: '2rem 1.5rem', textAlign: 'center' }}>
      <p style={kicker}>{hello(user)}</p>
      <p style={kicker}>Saldo pendiente</p>
      <p
        className="np-num"
        style={{
          ...balanceBig,
          color: negative ? 'var(--np-danger)' : 'var(--np-success)',
        }}
      >
        {balance ? formatEurAmount(balance.pendingCents) : '—'} <span style={curr}>EUR</span>
      </p>
      {balance && balance.availableCents !== undefined ? (
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.9375rem', color: 'var(--np-text-mute)' }}>
          Próximo pago <strong className="np-num">{formatEur(Math.max(0, balance.availableCents))}</strong>
          {balance.heldCents ? <> · en espera {formatEur(balance.heldCents)}</> : null}
          {balance.debtCents ? (
            <span style={{ color: 'var(--np-danger)' }}> · devoluciones −{formatEur(balance.debtCents)}</span>
          ) : null}
        </p>
      ) : null}
      {balance && balance.count > 0 ? (
        <p style={{ margin: 0, fontSize: 'var(--np-t-label)', color: 'var(--np-text-mute)' }}>
          {balance.count} cobro{balance.count === 1 ? '' : 's'} contabilizado{balance.count === 1 ? '' : 's'}
        </p>
      ) : null}
    </Card>
  );
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

// «Saldo pendiente» y compañía: mínimo 0.8125rem y el gris claro de etiquetas (11:1).
const kicker: CSSProperties = {
  margin: '0 0 0.25rem',
  fontSize: 'var(--np-t-label)',
  color: 'var(--np-text-label)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 600,
};

const balanceBig: CSSProperties = {
  margin: '0.25rem 0 0.5rem',
  fontSize: 'clamp(2.75rem, 12vw, 4rem)',
  fontWeight: 600,
  letterSpacing: '-0.04em',
  fontVariantNumeric: 'tabular-nums',
};

const curr: CSSProperties = {
  fontSize: '1rem',
  color: 'var(--np-text-mute)',
  fontWeight: 500,
  letterSpacing: '0.05em',
};
