'use client';

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Card, ScreenHelp } from '@nightpay/ui';
import { primeAlertSound } from '@/lib/alert-sound';
import type { OperatorUser } from '@/lib/api';
import { clearFichaContext } from '@/lib/ficha-context';
import { tabForOpenCharge, useOpenCharges } from '@/lib/open-charges';
import { roleAccess, type TabKey } from '@/lib/roles';
import { TOURS } from '@/lib/tours';
import { useUrlTab } from '@/lib/use-url-tab';
import {
  MyRightsContext,
  VenueMethodsContext,
  VenueNameContext,
  VenueNightContext,
  canTopUp,
  useVenueMethodsFeed,
  visibleTabsFor,
} from '@/lib/venue-methods';
import { ConnectionStatus } from './ConnectionStatus';
import { useDeepLinks, useMyNight, useOwnBalance, type PollError } from './dashboard-hooks';
import { Earnings } from './Earnings';
import { FichaTapped } from './FichaTapped';
import { HomeTab } from './HomeTab';
import { InvitationToast } from './InvitationToast';
import { PAGE_BOTTOM_SPACE } from './layout';
import { MyCobros } from './MyCobros';
import { MenuAvatar } from './my-profile';
import { PassScanned } from './PassScanned';
import { PendingPos } from './PendingPos';
import { ReceptionTab } from './reception/ReceptionTab';
import { ReservasTab } from './reservas/ReservasTab';
import { SafariNotice } from './SafariNotice';
import { useSessionExpired } from './session-context';
import { StaffMenu, StaffMenuContext } from './staff-menu';
import { TabBar } from './TabBar';
import cobrarStyles from './cobrar/cobrar.module.css';

interface Props {
  user: OperatorUser;
  /** «Salir»: quien monta el Dashboard cierra la sesión (y avisa si el servidor no lo confirma). */
  onLogout: () => void;
}

export function Dashboard({ user, onLogout }: Props) {
  // Cada rol ve sus pestañas y pide solo lo suyo (sin 403 de fondo).
  const access = roleAccess(user.role);
  // Formas de cobro apagadas por el dueño: sus pestañas no salen.
  const { methods, night: nightSettings, rights, venueName } = useVenueMethodsFeed(user.id);
  // Recepción (cargar saldos y el efectivo), solo a quien la hace por su puesto.
  const tabs = visibleTabsFor(access.tabs, methods, canTopUp(rights, user.role));
  // La pestaña va en la URL (?t=cobros): recargar o volver a entrar deja donde se estaba (?t=saldo, a Inicio).
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

  const showing = (key: TabKey) => links.ficha === null && links.pass === null && links.code === null && tab === key;
  // Recepción enseña su propia cabecera en todas sus pantallas (lo avisa ReceptionTab).
  const [deskHead, setDeskHead] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const openMenu = useCallback(() => setMenuOpen(true), []);
  // En Inicio manda la cabecera de «Cobrar» y en Recepción la suya: una sola
  // cabecera; el logo abre el menú («Salir»).
  const ownHeader = showing('home') || (showing('reception') && deskHead);

  return (
    <VenueMethodsContext.Provider value={methods}>
    <VenueNightContext.Provider value={nightSettings}>
    <MyRightsContext.Provider value={rights}>
    <VenueNameContext.Provider value={venueName}>
    <main className="np-app-root np-screen" style={mainStyle}>
      {/* Sin internet / OxioPay sin responder / el banco tardando: arriba, en ámbar. */}
      <ConnectionStatus serverDown={own.error?.transient === true} />
      {/* Cobros, Ganancias y la cola del datáfono: el logo abre el menú, con
          «Salir» dentro (como en Inicio y Recepción): nadie sale de la sesión
          por un toque sin querer. Sin tema: el personal va siempre en oscuro. */}
      {ownHeader ? null : (
        <header style={headerStyle}>
          <button type="button" className={cobrarStyles.logoTile} onClick={openMenu} aria-label="Menú">
            <MenuAvatar />
          </button>
          {/* El «?» de Cobros y de Ganancias, junto al logo (cada pantalla con su tutorial). */}
          {tab === 'payments' && showing('payments') ? <ScreenHelp {...TOURS.cobros} ready={!charges.open} /> : null}
          {tab === 'earnings' && showing('earnings') ? <ScreenHelp {...TOURS.ganancias} ready={!charges.open} /> : null}
        </header>
      )}
      {/* Instalada en un iPhone o un iPad: que abra Safari para la ficha y la cámara (fuera de un cobro). */}
      {charges.open ? null : <SafariNotice />}
      {/* La chica: «Te han invitado · +10 €» en cuanto se cobra su invitación. */}
      {access.ownEarnings ? <InvitationToast night={night.night} /> : null}

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
      ) : links.pass || links.code ? (
        // Su pase (?pase=) o el QR de la página de su saldo (?saldo=), leídos con la cámara del móvil.
        <PassScanned
          scan={links.pass ? { kind: 'pass', token: links.pass } : { kind: 'code', code: links.code ?? '' }}
          userId={user.id}
          onClose={() => {
            links.clearPass();
            links.clearCode();
            refreshMoney();
          }}
        />
      ) : null}

      {/* Inicio, la única pantalla de cobrar (QR, ficha NFC y, sin móvil ni
          ficha, su código o su pase), sigue montado al cambiar de pestaña: un
          cobro a medias (su QR, el tiempo real, el sondeo) no se pierde ni
          queda huérfano. */}
      <TabPanel visible={showing('home')}>
        <HomeTab user={user} night={night.night} onCobroDone={refreshMoney} onLogout={logout} />
      </TabPanel>
      {/* Recepción montada al cambiar de pestaña: una recarga a medias (su QR) no se pierde. */}
      {tabs.includes('reception') ? (
        <TabPanel visible={showing('reception')}>
          <StaffMenuContext.Provider value={openMenu}>
            <ReceptionTab user={user} active={showing('reception')} onOwnHeader={setDeskHead} />
          </StaffMenuContext.Provider>
        </TabPanel>
      ) : null}
      {tabs.includes('reservas') && showing('reservas') ? <ReservasTab /> : null}
      {access.posQueue && showing('pos') ? (
        <PendingPos onConfirmed={refreshMoney} focusPaymentId={links.focusedPosId} onFocusConsumed={links.clearFocus} />
      ) : null}
      {/* La misma lista que el panel para todos (/staff/me/cobros); la chica, además, cancela ahí lo suyo sin pagar. */}
      {access.ownPayments && showing('payments') ? (
        <MyCobros cancelPending={access.history.cancelPending} pollMs={access.history.pollMs} />
      ) : null}
      {access.ownEarnings && showing('earnings') ? (
        <Earnings night={night.night} balance={own.balance} nightError={night.error} />
      ) : null}

      <TabBar tabs={tabs} active={tab} onSelect={(next) => setTab(next)} />
      <StaffMenu open={menuOpen} onClose={() => setMenuOpen(false)} onLogout={logout} />
    </main>
    </VenueNameContext.Provider>
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
      <p style={{ color: 'var(--np-danger)', margin: 0, fontSize: 'var(--np-fs-16)' }}>{error.text}</p>
    </Card>
  );
}

const mainStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  // Abajo, el hueco de la barra de pestañas medida (con la zona segura) y un
  // respiro: lo último de cada página (Recepción, Mis cobros) se ve entero al
  // bajar. Arriba y entre bloques, --np-gap (más justo en el móvil).
  padding: `var(--np-gap) 1rem ${PAGE_BOTTOM_SPACE}`,
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
  gap: '0.5rem',
  paddingBottom: 'calc(var(--np-gap) * 0.75)',
  borderBottom: '1px solid var(--np-border)',
};
