'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Banner, ScreenHelp } from '@nightpay/ui';
import { primeAlertSound } from '@/lib/alert-sound';
import type { OperatorUser } from '@/lib/api';
import { isParty } from '@/lib/edition';
import { clearFichaContext } from '@/lib/ficha-context';
import { tabForOpenCharge, useOpenCharges } from '@/lib/open-charges';
import { editionAccess } from '@/lib/party-tabs';
import { roleAccess, type TabKey } from '@/lib/roles';
import { useMySections } from '@/lib/sections';
import { HOME_TAB, tabDirection } from '@/lib/tab-url';
import { TOURS } from '@/lib/tours';
import { useUrlTab } from '@/lib/use-url-tab';
import { VenueIdentityContext } from '@/lib/venue-identity';
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
import { PartySettings } from './party/PartySettings';
import { PayoutChangeNotice } from './PayoutChangeNotice';
import { PendingPos } from './PendingPos';
import { ReceptionTab } from './reception/ReceptionTab';
import { ReservasTab } from './reservas/ReservasTab';
import { SafariNotice } from './SafariNotice';
import { useSessionExpired } from './session-context';
import { StaffMenu, StaffMenuContext } from './staff-menu';
import { TabBar } from './TabBar';
import { cobraElEncargado } from './cobrar/cobrar-context';
import cobrarStyles from './cobrar/cobrar.module.css';

interface Props {
  user: OperatorUser;
  /** «Salir»: quien monta el Dashboard cierra la sesión (y avisa si el servidor no lo confirma). */
  onLogout: () => void;
}

export function Dashboard({ user, onLogout }: Props) {
  // Cada rol ve sus pestañas y pide solo lo suyo (sin 403 de fondo). OxioParty:
  // Cobrar (la barra), Taquilla, Cobros y Ajustes, sin nada de las chicas.
  const party = isParty();
  const access = editionAccess(roleAccess(user.role), party);
  // Formas de cobro apagadas por el dueño: sus pestañas no salen.
  const { methods, night: nightSettings, rights, venueName, identity } = useVenueMethodsFeed(user.id);
  // Recepción (cargar saldos y el efectivo), solo a quien la hace por su puesto.
  const tabs = visibleTabsFor(access.tabs, methods, canTopUp(rights, user.role));
  // La pestaña va en la URL (?t=cobros): recargar o volver a entrar deja donde se estaba (?t=saldo, a Inicio).
  const [tab, setTab] = useUrlTab(tabs);
  // La compañera con la casilla «Las compañeras cobran desde su móvil» apagada no cobra (la misma respuesta de
  // /venues/me que ya se pide: ninguna petición más). Solo se lee, para lo que se dice en un vacío.
  const mine = useMySections();
  const cobraEncargado = cobraElEncargado({ user, fromPhone: mine.fromPhone });
  // «Cobrar ahora» del vacío de Cobros: solo a quien cobra; a una compañera, cuando ya se sabe su casilla.
  const noCobrar = user.role === 'OPERATOR' && (!mine.loaded || cobraEncargado);
  // El cambio de pestaña se anima solo tras un toque en la barra (nunca al entrar ni por un enlace) y sin un cobro abierto.
  const switched = useRef(false);
  const [entered, setEntered] = useState<{ to: TabKey; dir: number; on: boolean } | null>(null);
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

  function selectTab(next: TabKey) {
    switched.current = true;
    setEntered({ to: next, dir: tabDirection(tabs, tab, next), on: switched.current && !charges.open });
    setTab(next);
  }
  // Si la pestaña cambia por otro camino (un enlace, «atrás»), aquella entrada ya no cuenta.
  useEffect(() => {
    setEntered((e) => (e && e.to !== tab ? null : e));
  }, [tab]);
  /** La pestaña a la que se acaba de llegar tocando la barra entra animada (las demás veces, quieta). */
  const moving = entered !== null && entered.on && entered.to === tab && entered.dir !== 0;
  const enter = (children: ReactNode) => (
    <div className={moving ? 'np-tab-in' : undefined} style={moving ? ({ ...panelStyle, '--np-tab-dir': entered.dir } as CSSProperties) : panelStyle}>
      {children}
    </div>
  );

  const showing = (key: TabKey) => links.ficha === null && links.pass === null && links.code === null && tab === key;
  // Recepción enseña su propia cabecera en todas sus pantallas (lo avisa ReceptionTab).
  const [deskHead, setDeskHead] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const openMenu = useCallback(() => setMenuOpen(true), []);
  // En Inicio manda la cabecera de «Cobrar» y en Recepción la suya: una sola
  // cabecera; el logo abre el menú («Salir»).
  // OxioParty: Ajustes lleva lo del menú dentro (sin la cabecera del logo).
  const ownHeader = showing('home') || (showing('reception') && deskHead) || (party && showing('settings'));

  return (
    <VenueMethodsContext.Provider value={methods}>
    <VenueNightContext.Provider value={nightSettings}>
    <MyRightsContext.Provider value={rights}>
    <VenueNameContext.Provider value={venueName}>
    <VenueIdentityContext.Provider value={identity}>
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
      {/* La compañera, al entrar: «Tu cuenta de cobro ha cambiado» hasta que pulsa «Entendido» (fuera de un cobro). */}
      {user.role === 'OPERATOR' ? <PayoutChangeNotice hidden={charges.open} /> : null}
      {/* La compañera: «Te han invitado · +10 €» en cuanto se cobra su invitación, y «Servicio cobrado · +54 €». */}
      {access.ownEarnings ? <InvitationToast night={night.night} userId={user.id} /> : null}

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
      <TabPanel visible={showing('home')} fade={moving}>
        <HomeTab user={user} night={night.night} onCobroDone={refreshMoney} onLogout={logout} />
      </TabPanel>
      {/* Recepción montada al cambiar de pestaña: una recarga a medias (su QR) no se pierde. */}
      {tabs.includes('reception') ? (
        <TabPanel visible={showing('reception')} fade={moving}>
          <StaffMenuContext.Provider value={openMenu}>
            <ReceptionTab user={user} active={showing('reception')} onOwnHeader={setDeskHead} />
          </StaffMenuContext.Provider>
        </TabPanel>
      ) : null}
      {tabs.includes('reservas') && showing('reservas') ? enter(<ReservasTab />) : null}
      {access.posQueue && showing('pos')
        ? enter(<PendingPos onConfirmed={refreshMoney} focusPaymentId={links.focusedPosId} onFocusConsumed={links.clearFocus} />)
        : null}
      {/* La misma lista que el panel para todos (/staff/me/cobros); la chica, además, cancela ahí lo suyo sin pagar. */}
      {access.ownPayments && showing('payments')
        ? enter(
            <MyCobros cancelPending={access.history.cancelPending} pollMs={access.history.pollMs} cobraEncargado={cobraEncargado} onCobrar={noCobrar ? undefined : () => selectTab(HOME_TAB)} />,
          )
        : null}
      {access.ownEarnings && showing('earnings')
        ? enter(
            <Earnings night={night.night} balance={own.balance} nightError={night.error} cobraEncargado={cobraEncargado} balanceLoading={own.balance === null && !own.error} />,
          )
        : null}
      {party && showing('settings') ? enter(<PartySettings onLogout={logout} />) : null}

      <TabBar tabs={tabs} active={tab} onSelect={selectTab} />
      <StaffMenu open={menuOpen} onClose={() => setMenuOpen(false)} onLogout={logout} />
    </main>
    </VenueIdentityContext.Provider>
    </VenueNameContext.Provider>
    </MyRightsContext.Provider>
    </VenueNightContext.Provider>
    </VenueMethodsContext.Provider>
  );
}

/** Inicio y Recepción siguen montados; al volver a ellos solo se funden (llevan dentro position: fixed: nada de transform). */
function TabPanel({ visible, fade = false, children }: { visible: boolean; fade?: boolean; children: ReactNode }) {
  return (
    <div hidden={!visible} className={visible && fade ? 'np-tab-fade' : undefined} style={visible ? panelStyle : undefined}>
      {children}
    </div>
  );
}

/** Un fallo que no se arregla solo (el servidor caído ya lo dice la franja de arriba). */
function PollErrorBanner({ error }: { error: PollError }) {
  return (
    <Banner tone="danger">{error.text}</Banner>
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
