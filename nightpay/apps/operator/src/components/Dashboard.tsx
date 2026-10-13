'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button, Card, Logo, ThemeToggle } from '@nightpay/ui';
import {
  fetchBalance,
  logout as apiLogout,
  type OperatorBalance,
  type OperatorUser,
} from '@/lib/api';
import { ChargeFromBalance } from './ChargeFromBalance';
import { CreatePayment } from './CreatePayment';
import { MyPayments } from './MyPayments';
import { Earnings } from './Earnings';
import { PendingPos } from './PendingPos';

type TabKey = 'home' | 'wallet' | 'pos' | 'payments' | 'earnings';

interface Props {
  user: OperatorUser;
  onLogout: () => void;
}

export function Dashboard({ user, onLogout }: Props) {
  const [tab, setTab] = useState<TabKey>('home');
  const [balance, setBalance] = useState<OperatorBalance | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Deep-link: si la URL tiene ?pos=<paymentId>, el camarero llegó aquí
  // escaneando el QR de un cobro POS — saltamos a la tab POS pre-filtrada.
  const [focusedPosId, setFocusedPosId] = useState<string | null>(null);

  async function reload() {
    try {
      const b = await fetchBalance();
      setBalance(b);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    reload();
    const int = setInterval(reload, 8000);
    return () => clearInterval(int);
  }, []);

  // Lee ?pos=<id> de la URL al cargar y al cambiar de hash/query.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const posId = params.get('pos');
    if (posId && user.role !== 'OPERATOR') {
      setFocusedPosId(posId);
      setTab('pos');
      // Limpia el query param para que un refresh no re-active el focus
      const url = new URL(window.location.href);
      url.searchParams.delete('pos');
      window.history.replaceState({}, '', url.toString());
    }
  }, [user.role]);

  async function logout() {
    await apiLogout();
    onLogout();
  }

  return (
    <main className="np-app-root" style={mainStyle}>
      <header style={headerStyle}>
        <Logo height="1.75rem" />
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: 'auto' }}>
          <ThemeToggle size="sm" />
          <Button variant="ghost" size="md" onClick={logout} style={{ height: '2.25rem' }}>
            Salir
          </Button>
        </div>
      </header>

      {error ? (
        <Card style={{ padding: '0.875rem', borderColor: 'var(--np-danger)' }}>
          <p style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.85rem' }}>{error}</p>
        </Card>
      ) : null}

      {tab === 'home' ? (
        <HomeTab user={user} balance={balance} onCobroDone={reload} />
      ) : tab === 'wallet' ? (
        <ChargeFromBalance onCharged={reload} />
      ) : tab === 'pos' ? (
        <PendingPos onConfirmed={reload} focusPaymentId={focusedPosId} />
      ) : tab === 'payments' ? (
        <MyPayments />
      ) : (
        <Earnings />
      )}

      <nav style={tabBarStyle} aria-label="Navegación principal">
        <TabBtn active={tab === 'home'} icon={<IconHome active={tab === 'home'} />} label="Inicio" onClick={() => setTab('home')} />
        <TabBtn active={tab === 'wallet'} icon={<IconWallet active={tab === 'wallet'} />} label="Saldo" onClick={() => setTab('wallet')} />
        {/* POS tab solo para WAITER/MANAGER/OWNER — la chica (OPERATOR) crea
            cobros POS pero no se los autoconfirma a ella misma. */}
        {user.role !== 'OPERATOR' ? (
          <TabBtn active={tab === 'pos'} icon={<IconPos active={tab === 'pos'} />} label="POS" onClick={() => setTab('pos')} />
        ) : null}
        <TabBtn active={tab === 'payments'} icon={<IconList active={tab === 'payments'} />} label="Cobros" onClick={() => setTab('payments')} />
        <TabBtn active={tab === 'earnings'} icon={<IconCoin active={tab === 'earnings'} />} label="Ganancias" onClick={() => setTab('earnings')} />
      </nav>
    </main>
  );
}

function HomeTab({
  user,
  balance,
  onCobroDone,
}: {
  user: OperatorUser;
  balance: OperatorBalance | null;
  onCobroDone: () => void;
}) {
  const negative = balance ? balance.pendingCents < 0 : false;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', flex: 1 }}>
      <Card variant="glow" style={{ padding: '2rem 1.5rem', textAlign: 'center' }}>
        <p style={kicker}>Hola{user.displayName ? `, ${user.displayName}` : ''} —</p>
        <p style={kicker}>Saldo pendiente</p>
        <p
          className="np-num"
          style={{
            ...balanceBig,
            color: negative ? 'var(--np-danger)' : 'var(--np-success)',
          }}
        >
          {balance ? (balance.pendingCents / 100).toFixed(2) : '—'}{' '}
          <span style={curr}>EUR</span>
        </p>
        {balance && balance.availableCents !== undefined ? (
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.9375rem', color: 'var(--np-text-mute)' }}>
            Próximo pago <strong className="np-num">{(Math.max(0, balance.availableCents) / 100).toFixed(2)} €</strong>
            {balance.heldCents ? <> · en espera {(balance.heldCents / 100).toFixed(2)} €</> : null}
            {balance.debtCents ? (
              <span style={{ color: 'var(--np-danger)' }}> · devoluciones −{(balance.debtCents / 100).toFixed(2)} €</span>
            ) : null}
          </p>
        ) : null}
        {balance && balance.count > 0 ? (
          <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--np-text-dim)' }}>
            {balance.count} cobro{balance.count === 1 ? '' : 's'} contabilizado{balance.count === 1 ? '' : 's'}
          </p>
        ) : null}
      </Card>

      <CreatePayment onCreated={onCobroDone} />
    </div>
  );
}

function TabBtn({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      style={{
        background: 'transparent',
        border: 'none',
        flex: 1,
        // 44px+ touch target en iOS — min-height fuerza zona tap aunque
        // padding pierda al safe-area-inset.
        minHeight: '3rem',
        padding: '0.625rem 0',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.25rem',
        color: active ? 'var(--np-accent)' : 'var(--np-text-mute)',
        cursor: 'pointer',
        fontSize: '0.7rem',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        fontWeight: 500,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '1.5rem' }}>{icon}</span>
      {label}
    </button>
  );
}

// SVG icons — consistentes en todas las plataformas, no dependen de fonts
// del sistema. Stroke-currentColor para heredar el color activo/inactivo.
const ICON_SIZE = 22;
function IconHome({ active }: { active: boolean }) {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12L12 3l9 9M5 10v10a1 1 0 001 1h3v-6h6v6h3a1 1 0 001-1V10" />
    </svg>
  );
}
function IconWallet({ active }: { active: boolean }) {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 12V8a2 2 0 00-2-2H5a1 1 0 01-1-1m0 0a1 1 0 011-1h14v4M4 5v14a2 2 0 002 2h12a2 2 0 002-2v-4" />
      <circle cx="17" cy="13" r="1.5" />
    </svg>
  );
}
function IconPos({ active }: { active: boolean }) {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M8 7h8M8 11h8M9 16h2" />
    </svg>
  );
}
function IconList({ active }: { active: boolean }) {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <circle cx="4" cy="6" r="1" fill="currentColor" />
      <circle cx="4" cy="12" r="1" fill="currentColor" />
      <circle cx="4" cy="18" r="1" fill="currentColor" />
    </svg>
  );
}
function IconCoin({ active }: { active: boolean }) {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" />
      <path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
    </svg>
  );
}

const mainStyle: CSSProperties = {
  minHeight: '100dvh',
  display: 'flex',
  flexDirection: 'column',
  // Padding bottom = altura nav + safe-area home indicator iOS.
  // Sin esto los iPhones modernos solapan la barra home con la tab bar.
  padding: '1rem 1rem calc(5rem + env(safe-area-inset-bottom))',
  gap: '1rem',
  maxWidth: '32rem',
  margin: '0 auto',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  paddingBottom: '0.75rem',
  borderBottom: '1px solid var(--np-border)',
};

const kicker: CSSProperties = {
  margin: '0 0 0.25rem',
  fontSize: '0.7rem',
  color: 'var(--np-text-dim)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 500,
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

const tabBarStyle: CSSProperties = {
  position: 'fixed',
  left: 0,
  right: 0,
  bottom: 0,
  background: 'var(--np-surface)',
  borderTop: '1px solid var(--np-border)',
  display: 'flex',
  maxWidth: '32rem',
  margin: '0 auto',
  // iOS home indicator inset — el área debajo del último tab queda
  // segura para gesture home.
  paddingBottom: 'env(safe-area-inset-bottom)',
};
