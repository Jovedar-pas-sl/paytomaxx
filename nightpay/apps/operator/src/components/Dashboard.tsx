'use client';

import { useCallback, useEffect, type CSSProperties, type ReactNode } from 'react';
import { Button, Card, Logo, ThemeToggle } from '@nightpay/ui';
import { primeAlertSound } from '@/lib/alert-sound';
import type { OperatorUser } from '@/lib/api';
import { clearFichaContext } from '@/lib/ficha-context';
import { tabForOpenCharge, useOpenCharges } from '@/lib/open-charges';
import { roleAccess, type TabKey } from '@/lib/roles';
import { useUrlTab } from '@/lib/use-url-tab';
import {
  MyRightsContext,
  VenueMethodsContext,
  VenueNightContext,
  canTopUp,
  useVenueMethodsFeed,
  visibleTabsFor,
} from '@/lib/venue-methods';
import { ChargeFromBalance } from './ChargeFromBalance';
import { ConnectionStatus } from './ConnectionStatus';
import { useDeepLinks, useMyNight, useOwnBalance, type PollError } from './dashboard-hooks';
import { Earnings } from './Earnings';
import { FichaTapped } from './FichaTapped';
import { HomeTab } from './HomeTab';
import { TAB_BAR_HEIGHT } from './layout';
import { MyPayments } from './MyPayments';
import { PassScanned } from './PassScanned';
import { PendingPos } from './PendingPos';
import { ReceptionTab } from './reception/ReceptionTab';
import { useSessionExpired } from './session-context';
import { TabBar } from './TabBar';

interface Props {
  user: OperatorUser;
  /** «Salir»: quien monta el Dashboard cierra la sesión (y avisa si el servidor no lo confirma). */
  onLogout: () => void;
}

export function Dashboard({ user, onLogout }: Props) {
  // Cada rol ve sus pestañas y pide solo lo suyo (sin 403 de fondo).
  const access = roleAccess(user.role);
  // Formas de cobro apagadas por el dueño: sus pestañas no salen.
  const { methods, night: nightSettings, rights } = useVenueMethodsFeed(user.id);
  // Recepción (cargar saldos y el efectivo), solo a quien la hace por su puesto.
  const tabs = visibleTabsFor(access.tabs, methods, canTopUp(rights, user.role));
  // La pestaña va en la URL (?t=saldo): recargar o volver a entrar deja donde se estaba.
  const [tab, setTab] = useUrlTab(tabs);
  const links = useDeepLinks(access.posQueue);
  // Sesión caducada con un cobro abierto: el saldo y la noche dejan de
  // preguntar y vuelven solos al entrar otra vez.
  const expired = useSessionExpired();
  const own = useOwnBalance(access.ownEarnings && !expired);
  const night = useMyNight(access.ownEarnings && !expired);
  const charges = useOpenCharges();
  const { refresh: refreshBalance } = own;
  const { refresh: refreshNight } = night;
  const refreshMoney = useCallback(() => {
    refreshBalance();
    refreshNight();
  }, [refreshBalance, refreshNight]);

  // ?pos=<id>: el camarero llegó escaneando el QR de un cobro con datáfono.
  useEffect(() => {
    if (links.focusedPosId) setTab('pos', 'replace');
  }, [links.focusedPosId]);

  // Al caducar la sesión, delante el cobro abierto (su QR sigue vivo en su pestaña).
  useEffect(() => {
    if (!expired) return;
    const target = tabForOpenCharge(charges.spots, tab);
    if (target) setTab(target, 'replace');
    // Solo al caducar: luego la chica mira lo que quiera.
  }, [expired]);

  // El sonido (cobro pagado o fallido; y el pitido de cobro nuevo en el POS)
  // queda listo con el primer toque en la app (iPhone no suena sin uno) y se
  // cierra al salir.
  useEffect(() => primeAlertSound(), []);

  function logout() {
    clearFichaContext();
    onLogout();
  }

  const showing = (key: TabKey) => links.ficha === null && links.pass === null && tab === key;

  return (
    <VenueMethodsContext.Provider value={methods}>
    <VenueNightContext.Provider value={nightSettings}>
    <MyRightsContext.Provider value={rights}>
    <main className="np-app-root np-screen" style={mainStyle}>
      {/* Sin internet / OxioPay sin responder / el banco tardando: arriba, en ámbar. */}
      <ConnectionStatus serverDown={own.error?.transient === true} />
      <header style={headerStyle}>
        <Logo height="1.75rem" />
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: 'auto' }}>
          <ThemeToggle />
          <Button variant="ghost" size="md" onClick={logout} style={headerBtnStyle}>
            Salir
          </Button>
        </div>
      </header>

      {/* Con la sesión caducada lo dice la hoja de entrar: aquí empujaría el QR hacia abajo. */}
      {own.error && !own.error.transient && !expired ? <PollErrorBanner error={own.error} /> : null}

      {links.ficha ? (
        <FichaTapped
          token={links.ficha}
          userId={user.id}
          onClose={() => {
            links.clearFicha();
            refreshMoney();
          }}
        />
      ) : links.pass ? (
        <PassScanned
          token={links.pass}
          userId={user.id}
          onClose={() => {
            links.clearPass();
            refreshMoney();
          }}
        />
      ) : null}

      {/* Inicio y Saldo siguen montados al cambiar de pestaña: un cobro a medias
          (su QR, el tiempo real, el sondeo) no se pierde ni queda huérfano. */}
      <TabPanel visible={showing('home')}>
        <HomeTab
          user={user}
          showBalance={access.ownEarnings}
          balance={own.balance}
          night={night.night}
          onCobroDone={refreshMoney}
          onOpenEarnings={() => setTab('earnings')}
        />
      </TabPanel>
      <TabPanel visible={showing('wallet')}>
        <ChargeFromBalance onCharged={refreshMoney} />
      </TabPanel>
      {/* Recepción montada al cambiar de pestaña: una recarga a medias (su QR) no se pierde. */}
      {tabs.includes('reception') ? (
        <TabPanel visible={showing('reception')}>
          <ReceptionTab />
        </TabPanel>
      ) : null}
      {access.posQueue && showing('pos') ? (
        <PendingPos onConfirmed={refreshMoney} focusPaymentId={links.focusedPosId} onFocusConsumed={links.clearFocus} />
      ) : null}
      {access.ownPayments && showing('payments') ? <MyPayments /> : null}
      {access.ownEarnings && showing('earnings') ? (
        <Earnings night={night.night} balance={own.balance} nightError={night.error} />
      ) : null}

      <TabBar tabs={tabs} active={tab} onSelect={(next) => setTab(next)} />
    </main>
    </MyRightsContext.Provider>
    </VenueNightContext.Provider>
    </VenueMethodsContext.Provider>
  );
}

function TabPanel({ visible, children }: { visible: boolean; children: ReactNode }) {
  return (
    <div hidden={!visible} style={visible ? panelStyle : undefined}>
      {children}
    </div>
  );
}

/** Un fallo que no se arregla solo (el servidor caído ya lo dice la franja de arriba). */
function PollErrorBanner({ error }: { error: PollError }) {
  return (
    <Card role="alert" style={{ padding: '0.875rem', borderColor: 'var(--np-danger)' }}>
      <p style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.9375rem' }}>{error.text}</p>
    </Card>
  );
}

const mainStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  // Padding bottom = altura nav + safe-area home indicator iOS.
  // Sin esto los iPhones modernos solapan la barra home con la tab bar.
  // Arriba y entre bloques, --np-gap (más justo en el móvil).
  padding: `var(--np-gap) 1rem calc(${TAB_BAR_HEIGHT} + var(--np-gap) + env(safe-area-inset-bottom))`,
  gap: 'var(--np-gap)',
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
  paddingBottom: 'calc(var(--np-gap) * 0.75)',
  borderBottom: '1px solid var(--np-border)',
};

// 44 px: se toca bien con el dedo (como el botón del tema, al lado).
const headerBtnStyle: CSSProperties = { height: '2.75rem', padding: '0 1rem' };
