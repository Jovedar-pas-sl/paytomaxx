'use client';

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Button, Card, Logo, ThemeToggle } from '@nightpay/ui';
import { primeAlertSound } from '@/lib/alert-sound';
import { logout as apiLogout, type OperatorUser } from '@/lib/api';
import { clearFichaContext } from '@/lib/ficha-context';
import { roleAccess, type TabKey } from '@/lib/roles';
import { ChargeFromBalance } from './ChargeFromBalance';
import { useDeepLinks, useOwnBalance, type PollError } from './dashboard-hooks';
import { Earnings } from './Earnings';
import { FichaTapped } from './FichaTapped';
import { HomeTab } from './HomeTab';
import { MyPayments } from './MyPayments';
import { PendingPos } from './PendingPos';
import { TabBar } from './TabBar';

interface Props {
  user: OperatorUser;
  onLogout: () => void;
}

export function Dashboard({ user, onLogout }: Props) {
  // Cada rol ve sus pestañas y pide solo lo suyo (sin 403 de fondo).
  const access = roleAccess(user.role);
  const [tab, setTab] = useState<TabKey>('home');
  const links = useDeepLinks(access.posQueue);
  const own = useOwnBalance(access.ownEarnings);

  // ?pos=<id>: el camarero llegó escaneando el QR de un cobro con datáfono.
  useEffect(() => {
    if (links.focusedPosId) setTab('pos');
  }, [links.focusedPosId]);

  // Quien confirma el datáfono: el pitido de cobro nuevo queda listo con su
  // primer toque en la app (iPhone no suena sin uno) y se cierra al salir.
  useEffect(() => (access.posQueue ? primeAlertSound() : undefined), [access.posQueue]);

  // La sesión local se cierra al momento; la del servidor sigue por detrás
  // (sin red no se queda nadie esperando en «Salir»).
  function logout() {
    clearFichaContext();
    void apiLogout();
    onLogout();
  }

  const showing = (key: TabKey) => links.ficha === null && tab === key;

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

      {own.error ? <PollErrorBanner error={own.error} /> : null}

      {links.ficha ? (
        <FichaTapped
          token={links.ficha}
          userId={user.id}
          onClose={() => {
            links.clearFicha();
            own.refresh();
          }}
        />
      ) : null}

      {/* Inicio y Saldo siguen montados al cambiar de pestaña: un cobro a medias
          (su QR, el tiempo real, el sondeo) no se pierde ni queda huérfano. */}
      <TabPanel visible={showing('home')}>
        <HomeTab user={user} showBalance={access.ownEarnings} balance={own.balance} onCobroDone={own.refresh} />
      </TabPanel>
      <TabPanel visible={showing('wallet')}>
        <ChargeFromBalance onCharged={own.refresh} />
      </TabPanel>
      {access.posQueue && showing('pos') ? (
        <PendingPos onConfirmed={own.refresh} focusPaymentId={links.focusedPosId} onFocusConsumed={links.clearFocus} />
      ) : null}
      {access.ownPayments && showing('payments') ? <MyPayments /> : null}
      {access.ownEarnings && showing('earnings') ? <Earnings /> : null}

      <TabBar tabs={access.tabs} active={tab} onSelect={setTab} />
    </main>
  );
}

function TabPanel({ visible, children }: { visible: boolean; children: ReactNode }) {
  return (
    <div hidden={!visible} style={visible ? panelStyle : undefined}>
      {children}
    </div>
  );
}

/** Servidor caído: aviso en ámbar (se reintenta solo); otro fallo: en rojo. */
function PollErrorBanner({ error }: { error: PollError }) {
  const color = error.transient ? 'var(--np-warning)' : 'var(--np-danger)';
  return (
    <Card role="alert" style={{ padding: '0.875rem', borderColor: color }}>
      <p style={{ color, margin: 0, fontSize: '0.85rem' }}>{error.text}</p>
    </Card>
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

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  paddingBottom: '0.75rem',
  borderBottom: '1px solid var(--np-border)',
};
