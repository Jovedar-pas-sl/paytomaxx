'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button, Logo, ScreenHelp, ThemeToggle } from '@nightpay/ui';
import { TAB_TOURS } from '@/lib/tours';
import { MyProfileButton, ProfileProvider } from './MyProfileButton';
import {
  fetchMyPermissions,
  fetchPaymentMethods,
  fetchTotpStatus,
  fetchVenueSettings,
  logout as apiLogout,
  type CobrosFilters,
  type User,
} from '@/lib/api';
import { DEFAULT_TIMEZONE } from '@/lib/dates';
import { isPartyEdition } from '@/lib/edition';
import { decidableCount } from '@/lib/approvals';
import { avisosCount, navBadge } from '@/lib/bottom-nav';
import {
  resolveTab,
  sectionOf,
  visibleSections,
  type PanelSection,
  type PanelTab,
  type SectionKey,
  type TabKey,
} from '@/lib/roles';
import { ApprovalsContext, useApprovalsFeed } from '@/lib/use-approvals';
import { IncidentsContext, useIncidentsFeed } from '@/lib/use-incidents';
import { useUrlNav } from '@/lib/use-url-nav';
import { SectionsContext, useSectionsFeed } from '@/lib/use-sections';
import { VenueContext, type VenueInfo } from '@/lib/venue-context';
import { AvisosPanel } from './AvisosPanel';
import { BankReconPanel } from './BankReconPanel';
import { BottomNav } from './BottomNav';
import { CartaPanel } from './CartaPanel';
import { NightsPanel } from './NightsPanel';
import { OxioPaySettlementsPanel } from './OxioPaySettlementsPanel';
import { OperatorsPanel } from './OperatorsPanel';
import { PaymentsPanel } from './PaymentsPanel';
import { ReservationsPanel, type ReservationsView } from './reservations/ReservationsPanel';
import { ReportsPanel } from './ReportsPanel';
import { SectionHint } from './SectionHint';
import { AlertsPanel } from './settings/AlertsPanel';
import { NightPanel } from './settings/NightPanel';
import { PaymentMethodsPanel } from './settings/PaymentMethodsPanel';
import { HomeTopUpPanel } from './settings/HomeTopUpPanel';
import { VenueKitPanel } from './settings/VenueKitPanel';
import { PermissionsPanel } from './settings/PermissionsPanel';
import { RulesPanel } from './settings/RulesPanel';
import { SecurityPanel } from './settings/SecurityPanel';
import { SuperAdminPanel } from './superadmin/SuperAdminPanel';
import { Skel } from './Skeleton';
import { TabBar, tabId, tabPanelId } from './TabBar';
import { TerminalsPanel } from './TerminalsPanel';
import { TreasuryPanel } from './TreasuryPanel';
import { VenueSwitcher } from './VenueSwitcher';
import { WalletsPanel } from './WalletsPanel';
import { FichasPanel } from './FichasPanel';
import { FichasProvider } from './fichas/FichasProvider';
import { MoneyMapPanel } from './money-map/MoneyMapPanel';
import { SectionsPanel } from './settings/SectionsPanel';
import { OverdueSettlementsBanner } from './settlements/OverdueBanner';
import { CierreSection } from './party/CierreSection';
import { DevolucionesSection } from './party/DevolucionesSection';
import { PartyLiveSection } from './party/PartyLiveSection';
import { PartySettingsSection } from './party/PartySettingsSection';
import { PulserasSection } from './party/PulserasSection';
import { StallsSection } from './party/StallsSection';

interface Props {
  user: User;
  /** `serverConfirmed`: el API revocó la sesión (si no, el login lo avisa). */
  onLogout: (serverConfirmed: boolean) => void;
}

const SECTIONS_ID = 'np-panel';
const SUBTABS_ID = 'np-sub';

const ROLE_LABELS: Record<User['role'], string> = {
  OWNER: 'Dueño',
  MANAGER: 'Encargado',
  WAITER: 'Camarero',
  OPERATOR: 'Operadora',
};

/**
 * El panel: cinco secciones (Hoy, Chicas, Clientes, Informes, Ajustes)
 * arriba en el escritorio y abajo en el móvil, y dentro de cada una sus
 * pestañas y una línea con lo que hay (SectionHint). «Hoy» lleva un solo
 * globo: incidencias + lo que hay por aprobar.
 * OxioParty (NEXT_PUBLIC_EDITION=party): el panel del organizador, con sus
 * seis secciones (En directo, Casetas, Pulseras, Devoluciones, Cierre y
 * Ajustes; lib/roles) y el globo en En directo.
 */
export function Dashboard({ user, onLogout }: Props) {
  const [venue, venueSettled] = useVenueInfo(user);
  const reports = useCanSeeReports(user);
  // Datáfono apagado en Formas de cobro: fuera la pestaña Datáfonos (y su permiso).
  const [posOn, setPosOn, posKnown] = useVenuePosOn(user);
  const viewer = { role: user.role, isSuperAdmin: user.isSuperAdmin, canSeeReports: reports.can, posOn };
  const sections = visibleSections(viewer);
  const tabs = sections.flatMap((s) => s.tabs);
  // La sección y la pestaña van en la URL (?s=ajustes&t=formas): recargar deja donde se estaba.
  // Una que este rol no ve nunca se pinta (se vuelve a Cobros).
  const [tab, navigate] = useUrlNav(sections, {
    permissive: visibleSections({ ...viewer, canSeeReports: true, posOn: true }),
    settled: reports.known && posKnown,
  });
  /** La pestaña que se miró la última vez en cada sección (volver a la sección la abre). */
  const [lastInSection, setLastInSection] = useState<Partial<Record<SectionKey, TabKey>>>({});
  useEffect(() => {
    setLastInSection((prev) => (prev[sectionOf(tab)] === tab ? prev : { ...prev, [sectionOf(tab)]: tab }));
  }, [tab]);
  const section = sections.find((s) => s.key === sectionOf(tab)) ?? sections[0];
  const isOwner = user.role === 'OWNER';
  const incidents = useIncidentsFeed(user.tenantId, venue.timezone);
  const approvals = useApprovalsFeed(user);
  const venueSections = useSectionsFeed(user.tenantId);
  const avisos = avisosCount({ incidents: incidents.open, approvals: decidableCount(approvals.pending), isOwner });
  const missing2fa = useSuperAdminWithout2fa(user);
  const [loggingOut, setLoggingOut] = useState(false);
  /** Cobro a abrir en Cobros (desde una incidencia: «Abrir cobro»). */
  const [focusPayment, setFocusPayment] = useState<string | null>(null);
  /** Filtros con los que abrir Cobros (desde una cifra del mapa del dinero). */
  const [cobrosFilter, setCobrosFilter] = useState<CobrosFilters | null>(null);
  /** La vista con la que se abre Reservados y RRPP (el atajo de Compañeras: los RRPP); null = la de siempre. */
  const [reservasView, setReservasView] = useState<ReservationsView | null>(null);

  async function logout() {
    setLoggingOut(true);
    onLogout(await apiLogout());
  }

  /** Desde la barra, una pestaña o un enlace dentro de un panel: al principio de la sección. */
  function goTo(key: TabKey | string): void {
    const target = resolveTab(key);
    if (!target) return;
    setReservasView(null);
    navigate(target);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
  }

  function goToSection(key: SectionKey): void {
    const next = sections.find((s) => s.key === key);
    const first = next?.tabs[0];
    if (!next || !first) return;
    const last = lastInSection[key];
    goTo(last && next.tabs.some((t) => t.key === last) ? last : first.key);
  }

  function openPayment(paymentId: string): void {
    setFocusPayment(paymentId);
    goTo('payments');
  }

  function openCobros(filter: CobrosFilters): void {
    setCobrosFilter(filter);
    goTo('payments');
  }

  /** Desde Compañeras: los RRPP y sus enlaces (Clientes → Reservados y RRPP). */
  function openRrpp(): void {
    goTo('reservations');
    setReservasView('promoters');
  }

  const party = isPartyEdition();
  // La sección que lleva Avisos y su globo: Hoy (en OxioParty, En directo).
  const avisosSection: SectionKey = party ? 'directo' : 'hoy';
  const hoyBadge = navBadge(avisosSection, avisos);

  return (
    <ProfileProvider>
    <VenueContext.Provider value={venue}>
      <IncidentsContext.Provider value={incidents}>
        <ApprovalsContext.Provider value={approvals}>
          <SectionsContext.Provider value={venueSections}>
          <FichasProvider isOwner={isOwner}>
          <main className="np-app-root" style={mainStyle}>
            <header className="np-panel-header" style={headerStyle}>
              <div className="np-brand" style={{ display: 'flex', alignItems: 'center', gap: '1rem', minWidth: 0 }}>
                {/* El logo, pequeño (≈ 18 px de letra): lo que manda es el local. En OxioParty, su nombre. */}
                {party ? <span className="np-party-mark">OxioParty</span> : <Logo height="1.875rem" />}
                <div style={{ borderLeft: '1px solid var(--np-border)', paddingLeft: '1rem', minWidth: 0 }}>
                  <p style={brandKicker}>{party ? 'Panel del organizador · la fiesta' : 'Panel · local activo'}</p>
                  {/* El local en grande: con varios locales, que nadie opere en el que no es. */}
                  {/* Hasta que llega el nombre, una silueta del mismo alto: nunca el slug («sala-aurora») antes que el nombre. */}
                  {venue.name || venueSettled ? (
                    <h1 style={brandTitle}>{venue.name ?? user.venueSlug}</h1>
                  ) : (
                    <h1 style={brandTitle} aria-busy="true">
                      <Skel width="11rem" height="1.375rem" style={{ marginTop: '0.125rem' }} />
                      <span className="np-sr-only">Cargando el local</span>
                    </h1>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                {user.isSuperAdmin ? <VenueSwitcher currentSlug={user.venueSlug} /> : null}
                <div className="np-header-account" style={{ textAlign: 'right' }}>
                  <span style={userEmail}>{user.email}</span>
                  <span style={userMeta}>
                    <code style={code}>{user.venueSlug}</code> · {ROLE_LABELS[user.role]}
                    {user.isSuperAdmin ? ' · super-admin' : ''}
                  </span>
                </div>
                {/* El «?» de la pestaña que se ve: su tutorial, en la barra de arriba. Las páginas son lentas en cargar: espera un poco más antes de salir solo. */}
                {TAB_TOURS[tab] ? <ScreenHelp key={tab} {...TAB_TOURS[tab]} delayMs={1500} /> : null}
                {/* Mi foto: abre «Mi perfil» (también en el móvil, donde la cuenta y «Salir» se esconden). */}
                <MyProfileButton user={user} onLogout={() => void logout()} />
                {/* 36 px como «Salir»; en el móvil, 44 (panel-nav.css). */}
                <span className="np-theme-toggle">
                  <ThemeToggle size="sm" />
                </span>
                <Button variant="ghost" size="sm" className="np-header-account" onClick={() => void logout()} loading={loggingOut}>
                  Salir
                </Button>
              </div>
            </header>

            {missing2fa ? <Missing2faBanner onEnable={() => goTo('security')} /> : null}
            {isOwner && !party ? <OverdueSettlementsBanner tenantId={user.tenantId} onOpen={() => goTo('oxiopay')} /> : null}

            <TabBar
              tabs={sections}
              active={section?.key ?? avisosSection}
              onChange={goToSection}
              ariaLabel="Secciones del panel"
              idPrefix={SECTIONS_ID}
              className="np-tabbar-main"
              badges={{ [avisosSection]: hoyBadge }}
            />

            {section ? (
              <div
                role="tabpanel"
                className="np-panel-body"
                id={tabPanelId(SECTIONS_ID, section.key)}
                aria-labelledby={tabId(SECTIONS_ID, section.key)}
              >
                <SectionTabs section={section} active={tab} onChange={goTo} avisosBadge={hoyBadge} pending={posKnown ? [] : ['terminals']} />
                <SectionHint section={section} tabs={tabs} onOpenRrpp={openRrpp} />
                <div
                  className="np-panel-view"
                  {...(section.tabs.length > 1
                    ? { role: 'tabpanel', id: tabPanelId(SUBTABS_ID, tab), 'aria-labelledby': tabId(SUBTABS_ID, tab) }
                    : {})}
                >
                  <ActivePanel
                    tab={tab}
                    tabs={tabs}
                    user={user}
                    onNavigate={goTo}
                    onOpenPayment={openPayment}
                    focusPayment={focusPayment}
                    onFocusPaymentDone={() => setFocusPayment(null)}
                    onOpenCobros={openCobros}
                    cobrosFilter={cobrosFilter}
                    onCobrosFilterDone={() => setCobrosFilter(null)}
                    reservasView={reservasView}
                    onLogout={() => void logout()}
                    loggingOut={loggingOut}
                    posOn={posOn}
                    onPosChange={setPosOn}
                  />
                </div>
              </div>
            ) : null}
          </main>

          <BottomNav sections={sections} active={section?.key ?? avisosSection} onChange={goToSection} avisos={avisos} />
          </FichasProvider>
          </SectionsContext.Provider>
        </ApprovalsContext.Provider>
      </IncidentsContext.Provider>
    </VenueContext.Provider>
    </ProfileProvider>
  );
}

/** Las pestañas de una sección (si tiene más de una), en pequeño. */
function SectionTabs({
  section,
  active,
  onChange,
  avisosBadge,
  pending,
}: {
  section: PanelSection;
  active: TabKey;
  onChange: (key: TabKey) => void;
  avisosBadge: { text: string; spoken: string } | null;
  /** Pestañas que aún no se sabe si salen (Datáfonos): una silueta en su sitio, sin que aparezcan y desaparezcan. */
  pending: readonly TabKey[];
}) {
  if (section.tabs.length < 2) return null;
  return (
    <TabBar
      tabs={section.tabs}
      active={active}
      onChange={onChange}
      ariaLabel={`${section.label}: apartados`}
      idPrefix={SUBTABS_ID}
      size="sm"
      className="np-subtabs"
      badges={{ incidents: avisosBadge }}
      pending={pending}
    />
  );
}

/** Super-admin sin 2FA: con la contraseña sola se entraría en todos los locales. */
function Missing2faBanner({ onEnable }: { onEnable: () => void }) {
  return (
    <div role="alert" className="np-2fa-banner">
      <p>
        <strong>Activa la verificación en dos pasos.</strong> Eres super-admin: sin ella, con tu contraseña se entra en
        todos los locales, y no puedes cambiar de local.
      </p>
      <Button onClick={onEnable}>Activarla</Button>
    </div>
  );
}

interface ActivePanelProps {
  tab: TabKey;
  tabs: readonly PanelTab[];
  user: User;
  onNavigate: (key: TabKey) => void;
  onOpenPayment: (paymentId: string) => void;
  focusPayment: string | null;
  onFocusPaymentDone: () => void;
  /** Desde el mapa del dinero: Cobros con los filtros de esa cifra. */
  onOpenCobros: (filter: CobrosFilters) => void;
  cobrosFilter: CobrosFilters | null;
  onCobrosFilterDone: () => void;
  /** La vista con la que se abre Reservados y RRPP (null: la de siempre). */
  reservasView: ReservationsView | null;
  onLogout: () => void;
  loggingOut: boolean;
  /** El local cobra con datáfono (Formas de cobro). */
  posOn: boolean;
  /** Formas de cobro guardadas: las pestañas se ponen al día sin recargar. */
  onPosChange: (posOn: boolean) => void;
}

function ActivePanel(props: ActivePanelProps) {
  const { tab, tabs, user, onNavigate } = props;
  const isOwner = user.role === 'OWNER';
  switch (tab) {
    case 'payments':
      return (
        <PaymentsPanel
          user={user}
          onNavigate={onNavigate}
          focusPaymentId={props.focusPayment}
          onFocusDone={props.onFocusPaymentDone}
          initialFilter={props.cobrosFilter}
          onInitialFilterDone={props.onCobrosFilterDone}
          // «Descargar»: quien ve el mapa del dinero (el dueño, y el encargado con «ver informes»).
          canExport={tabs.some((t) => t.key === 'money')}
        />
      );
    case 'money':
      return <MoneyMapPanel onNavigate={onNavigate} onOpenCobros={props.onOpenCobros} />;
    case 'incidents':
      return <AvisosPanel isOwner={isOwner} tabs={tabs} onNavigate={onNavigate} onOpenPayment={props.onOpenPayment} />;
    case 'operators':
      return <OperatorsPanel isOwner={isOwner} />;
    case 'treasury':
      return <TreasuryPanel isOwner={isOwner} onNavigate={onNavigate} />;
    case 'wallets':
      return <WalletsPanel isOwner={isOwner} />;
    case 'fichas':
      return <FichasPanel />;
    case 'reservations':
      return <ReservationsPanel isOwner={isOwner} initialView={props.reservasView ?? undefined} />;
    case 'nights':
      return <NightsPanel tabs={tabs} onNavigate={onNavigate} isOwner={isOwner} onOpenCobros={props.onOpenCobros} />;
    case 'reports':
      return <ReportsPanel isOwner={isOwner} />;
    case 'bank':
      return <BankReconPanel isOwner={isOwner} />;
    case 'oxiopay':
      return isOwner ? <OxioPaySettlementsPanel /> : null;
    case 'carta':
      return <CartaPanel />;
    case 'terminals':
      return <TerminalsPanel isOwner={isOwner} />;
    case 'rules':
      return isOwner ? <RulesPanel /> : null;
    case 'methods':
      return isOwner ? (
        <div className="np-set-stack">
          <PaymentMethodsPanel onSaved={(m) => props.onPosChange(m.pos)} />
          <HomeTopUpPanel />
          {/* El material del local dice «OxioPay»: en OxioParty no sale hasta que tenga el suyo. */}
          {isPartyEdition() ? null : <VenueKitPanel />}
        </div>
      ) : null;
    case 'night':
      return isOwner ? <NightPanel /> : null;
    case 'permissions':
      return isOwner ? <PermissionsPanel posOn={props.posOn} /> : null;
    case 'sections':
      return isOwner ? <SectionsPanel /> : null;
    case 'alerts':
      return isOwner ? <AlertsPanel /> : null;
    case 'security':
      return <SecurityPanel user={user} onLogout={props.onLogout} loggingOut={props.loggingOut} />;
    case 'superadmin':
      return user.isSuperAdmin ? <SuperAdminPanel user={user} onNavigate={onNavigate} /> : null;
    // OxioParty (lib/roles: PARTY_TABS; con OxioPay no salen nunca).
    case 'live':
      return <PartyLiveSection onNavigate={onNavigate} />;
    case 'stalls':
      return <StallsSection />;
    case 'wristbands':
      return <PulserasSection />;
    case 'partyRefunds':
      return <DevolucionesSection />;
    case 'settlement':
      return <CierreSection />;
    case 'party':
      return <PartySettingsSection isOwner={isOwner} />;
  }
}

/**
 * Nombre y zona horaria del local activo (Ajustes del local). Mientras no
 * llegan, o si fallan, se enseña el slug y las horas van en hora de Madrid.
 */
function useVenueInfo(user: User): [VenueInfo, boolean] {
  const [info, setInfo] = useState<VenueInfo>({ name: null, slug: user.venueSlug, timezone: DEFAULT_TIMEZONE });
  /** Ya contestó (bien o mal): sin nombre, la cabecera enseña el slug. */
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchVenueSettings()
      .then((s) => {
        if (!cancelled) setInfo({ name: s.name, slug: s.slug, timezone: s.timezone || DEFAULT_TIMEZONE });
      })
      .catch(() => {
        // Sin ajustes se sigue con el slug y Madrid; cada pestaña enseña sus propios errores.
      })
      .finally(() => {
        if (!cancelled) setSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [user.tenantId]);

  return [info, settled];
}

interface ReportsAccess {
  can: boolean;
  /** Ya se sabe (o falló la pregunta). */
  known: boolean;
}

const REPORTS_NO: ReportsAccess = { can: false, known: true };
const REPORTS_ASKING: ReportsAccess = { can: false, known: false };

/** El encargado ve los informes si el dueño le deja (Ajustes → Permisos). El dueño, siempre. */
function useCanSeeReports(user: User): ReportsAccess {
  const [state, setState] = useState<ReportsAccess>(user.role === 'MANAGER' ? REPORTS_ASKING : REPORTS_NO);
  useEffect(() => {
    if (user.role !== 'MANAGER') {
      setState(REPORTS_NO);
      return undefined;
    }
    setState(REPORTS_ASKING);
    let cancelled = false;
    fetchMyPermissions()
      .then((p) => {
        if (!cancelled) setState({ can: p.reports, known: true });
      })
      .catch(() => {
        // Sin respuesta, como siempre: el encargado no ve los informes.
        if (!cancelled) setState(REPORTS_NO);
      });
    return () => {
      cancelled = true;
    };
  }, [user.role, user.tenantId]);
  return state;
}

/**
 * ¿Cobra el local con datáfono? (Ajustes → Formas de cobro). Mientras no se
 * sabe, o si falla, sí: como antes (el API sigue mandando). El tercero: ya
 * se sabe (o falló la pregunta).
 */
function useVenuePosOn(user: User): [boolean, (posOn: boolean) => void, boolean] {
  const [posOn, setPosOn] = useState(true);
  const [known, setKnown] = useState(false);
  useEffect(() => {
    setPosOn(true);
    setKnown(false);
    let cancelled = false;
    fetchPaymentMethods()
      .then((m) => {
        if (!cancelled) setPosOn(m.pos);
      })
      .catch(() => {
        // Sin respuesta: todo a la vista, como antes.
      })
      .finally(() => {
        if (!cancelled) setKnown(true);
      });
    return () => {
      cancelled = true;
    };
  }, [user.tenantId]);
  return [posOn, setPosOn, known];
}

/** Super-admin sin la 2FA activada (para el aviso de arriba). Ante la duda, no se avisa. */
function useSuperAdminWithout2fa(user: User): boolean {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!user.isSuperAdmin) return undefined;
    let cancelled = false;
    fetchTotpStatus()
      .then((s) => {
        if (!cancelled) setMissing(!s.enabled);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user.isSuperAdmin, user.id]);
  return missing;
}

const mainStyle: CSSProperties = {
  minHeight: '100dvh',
  padding: 'clamp(1rem, 4vw, 2rem)',
  maxWidth: '88rem',
  margin: '0 auto',
  display: 'flex',
  flexDirection: 'column',
  gap: '1.5rem',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingBottom: '0.75rem',
  borderBottom: '1px solid var(--np-border)',
  flexWrap: 'wrap',
  gap: '1rem',
};

// Etiqueta 12/500 sin mayúsculas (Grafito).
const brandKicker: CSSProperties = {
  margin: 0,
  fontSize: '0.875rem',
  lineHeight: 1.3,
  color: 'var(--np-text-dim)',
  fontWeight: 400,
};

// 22/600: se distingue el local de un vistazo sin comerse la pantalla.
const brandTitle: CSSProperties = {
  margin: '0.125rem 0 0',
  fontSize: '1.375rem',
  lineHeight: 1.2,
  fontWeight: 600,
  color: 'var(--np-text)',
  // Por palabras («Luna / Valencia»), no a mitad de una.
  overflowWrap: 'break-word',
};

const userEmail: CSSProperties = {
  display: 'block',
  margin: 0,
  fontSize: '0.875rem',
  fontWeight: 400,
  color: 'var(--np-text)',
};

const userMeta: CSSProperties = {
  display: 'block',
  margin: '0.25rem 0 0',
  fontSize: '0.875rem',
  color: 'var(--np-text-mute)',
};

const code: CSSProperties = {
  fontFamily: 'var(--np-font-mono)',
  background: 'var(--np-surface-2)',
  padding: '0.1rem 0.4rem',
  borderRadius: '4px',
  fontSize: '0.875rem',
};
