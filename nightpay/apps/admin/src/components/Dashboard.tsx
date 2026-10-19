'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button, Logo, ThemeToggle } from '@nightpay/ui';
import { fetchMyPermissions, fetchTotpStatus, fetchVenueSettings, logout as apiLogout, type User } from '@/lib/api';
import { DEFAULT_TIMEZONE } from '@/lib/dates';
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
import { VenueContext, type VenueInfo } from '@/lib/venue-context';
import { AvisosPanel } from './AvisosPanel';
import { BankReconPanel } from './BankReconPanel';
import { BottomNav } from './BottomNav';
import { CartaPanel } from './CartaPanel';
import { NightsPanel } from './NightsPanel';
import { OperatorsPanel } from './OperatorsPanel';
import { PaymentsPanel } from './PaymentsPanel';
import { ReportsPanel } from './ReportsPanel';
import { AlertsPanel } from './settings/AlertsPanel';
import { PaymentMethodsPanel } from './settings/PaymentMethodsPanel';
import { PermissionsPanel } from './settings/PermissionsPanel';
import { RulesPanel } from './settings/RulesPanel';
import { SecurityPanel } from './settings/SecurityPanel';
import { SuperAdminPanel } from './superadmin/SuperAdminPanel';
import { TabBar, tabId, tabPanelId } from './TabBar';
import { TerminalsPanel } from './TerminalsPanel';
import { TreasuryPanel } from './TreasuryPanel';
import { VenueSwitcher } from './VenueSwitcher';
import { WalletsPanel } from './WalletsPanel';

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
 * pestañas. «Hoy» lleva un solo globo: incidencias + lo que hay por aprobar.
 */
export function Dashboard({ user, onLogout }: Props) {
  const venue = useVenueInfo(user);
  const canSeeReports = useCanSeeReports(user);
  const sections = visibleSections({ role: user.role, isSuperAdmin: user.isSuperAdmin, canSeeReports });
  const tabs = sections.flatMap((s) => s.tabs);
  const [selected, setSelected] = useState<TabKey>('payments');
  /** La pestaña que se miró la última vez en cada sección (volver a la sección la abre). */
  const [lastInSection, setLastInSection] = useState<Partial<Record<SectionKey, TabKey>>>({});
  // Una pestaña que este rol no ve nunca se pinta (se vuelve a Cobros).
  const tab: TabKey = tabs.some((t) => t.key === selected) ? selected : 'payments';
  const section = sections.find((s) => s.key === sectionOf(tab)) ?? sections[0];
  const isOwner = user.role === 'OWNER';
  const incidents = useIncidentsFeed(user.tenantId, venue.timezone);
  const approvals = useApprovalsFeed(user);
  const avisos = avisosCount({ incidents: incidents.open, approvals: decidableCount(approvals.pending), isOwner });
  const missing2fa = useSuperAdminWithout2fa(user);
  const [loggingOut, setLoggingOut] = useState(false);
  /** Cobro a abrir en Cobros (desde una incidencia: «Abrir cobro»). */
  const [focusPayment, setFocusPayment] = useState<string | null>(null);

  async function logout() {
    setLoggingOut(true);
    onLogout(await apiLogout());
  }

  /** Desde la barra, una pestaña o un enlace dentro de un panel: al principio de la sección. */
  function goTo(key: TabKey | string): void {
    const target = resolveTab(key);
    if (!target) return;
    setSelected(target);
    setLastInSection((prev) => ({ ...prev, [sectionOf(target)]: target }));
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

  const hoyBadge = navBadge('hoy', avisos);

  return (
    <VenueContext.Provider value={venue}>
      <IncidentsContext.Provider value={incidents}>
        <ApprovalsContext.Provider value={approvals}>
          <main className="np-app-root" style={mainStyle}>
            <header style={headerStyle}>
              <div className="np-brand" style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', minWidth: 0 }}>
                <Logo height="2.25rem" />
                <div style={{ borderLeft: '1px solid var(--np-border)', paddingLeft: '1.25rem', minWidth: 0 }}>
                  <p style={brandKicker}>Panel · local activo</p>
                  {/* El local en grande: con varios locales, que nadie opere en el que no es. */}
                  <h1 style={brandTitle}>{venue.name ?? user.venueSlug}</h1>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                {user.isSuperAdmin ? <VenueSwitcher currentSlug={user.venueSlug} /> : null}
                <div className="np-header-account" style={{ textAlign: 'right' }}>
                  <span style={userEmail}>{user.email}</span>
                  <span style={userMeta}>
                    <code style={code}>{user.venueSlug}</code> · {ROLE_LABELS[user.role]}
                    {user.isSuperAdmin ? ' · super-admin' : ''}
                  </span>
                </div>
                <ThemeToggle />
                <Button variant="ghost" className="np-header-account" onClick={() => void logout()} loading={loggingOut}>
                  Salir
                </Button>
              </div>
            </header>

            {missing2fa ? <Missing2faBanner onEnable={() => goTo('security')} /> : null}

            <TabBar
              tabs={sections}
              active={section?.key ?? 'hoy'}
              onChange={goToSection}
              ariaLabel="Secciones del panel"
              idPrefix={SECTIONS_ID}
              className="np-tabbar-main"
              badges={{ hoy: hoyBadge }}
            />

            {section ? (
              <div
                role="tabpanel"
                className="np-panel-body"
                id={tabPanelId(SECTIONS_ID, section.key)}
                aria-labelledby={tabId(SECTIONS_ID, section.key)}
              >
                <SectionTabs section={section} active={tab} onChange={goTo} avisosBadge={hoyBadge} />
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
                    onLogout={() => void logout()}
                    loggingOut={loggingOut}
                  />
                </div>
              </div>
            ) : null}
          </main>

          <BottomNav sections={sections} active={section?.key ?? 'hoy'} onChange={goToSection} avisos={avisos} />
        </ApprovalsContext.Provider>
      </IncidentsContext.Provider>
    </VenueContext.Provider>
  );
}

/** Las pestañas de una sección (si tiene más de una), en pequeño. */
function SectionTabs({
  section,
  active,
  onChange,
  avisosBadge,
}: {
  section: PanelSection;
  active: TabKey;
  onChange: (key: TabKey) => void;
  avisosBadge: { text: string; spoken: string } | null;
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
  onLogout: () => void;
  loggingOut: boolean;
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
        />
      );
    case 'incidents':
      return <AvisosPanel isOwner={isOwner} tabs={tabs} onNavigate={onNavigate} onOpenPayment={props.onOpenPayment} />;
    case 'operators':
      return <OperatorsPanel isOwner={isOwner} />;
    case 'treasury':
      return <TreasuryPanel isOwner={isOwner} />;
    case 'wallets':
      return <WalletsPanel isOwner={isOwner} />;
    case 'nights':
      return <NightsPanel tabs={tabs} onNavigate={onNavigate} />;
    case 'reports':
      return <ReportsPanel isOwner={isOwner} />;
    case 'bank':
      return <BankReconPanel isOwner={isOwner} />;
    case 'carta':
      return <CartaPanel />;
    case 'terminals':
      return <TerminalsPanel isOwner={isOwner} />;
    case 'rules':
      return isOwner ? <RulesPanel /> : null;
    case 'methods':
      return isOwner ? <PaymentMethodsPanel /> : null;
    case 'permissions':
      return isOwner ? <PermissionsPanel /> : null;
    case 'alerts':
      return isOwner ? <AlertsPanel /> : null;
    case 'security':
      return <SecurityPanel user={user} onLogout={props.onLogout} loggingOut={props.loggingOut} />;
    case 'superadmin':
      return user.isSuperAdmin ? <SuperAdminPanel user={user} onNavigate={onNavigate} /> : null;
  }
}

/**
 * Nombre y zona horaria del local activo (Ajustes del local). Mientras no
 * llegan, o si fallan, se enseña el slug y las horas van en hora de Madrid.
 */
function useVenueInfo(user: User): VenueInfo {
  const [info, setInfo] = useState<VenueInfo>({ name: null, slug: user.venueSlug, timezone: DEFAULT_TIMEZONE });

  useEffect(() => {
    let cancelled = false;
    fetchVenueSettings()
      .then((s) => {
        if (!cancelled) setInfo({ name: s.name, slug: s.slug, timezone: s.timezone || DEFAULT_TIMEZONE });
      })
      .catch(() => {
        // Sin ajustes se sigue con el slug y Madrid; cada pestaña enseña sus propios errores.
      });
    return () => {
      cancelled = true;
    };
  }, [user.tenantId]);

  return info;
}

/** El encargado ve los informes si el dueño le deja (Ajustes → Permisos). El dueño, siempre. */
function useCanSeeReports(user: User): boolean {
  const [can, setCan] = useState(false);
  useEffect(() => {
    setCan(false);
    if (user.role !== 'MANAGER') return undefined;
    let cancelled = false;
    fetchMyPermissions()
      .then((p) => {
        if (!cancelled) setCan(p.reports);
      })
      .catch(() => {
        // Sin respuesta, como siempre: el encargado no ve los informes.
      });
    return () => {
      cancelled = true;
    };
  }, [user.role, user.tenantId]);
  return can;
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
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  paddingBottom: '1rem',
  borderBottom: '1px solid var(--np-border)',
  flexWrap: 'wrap',
  gap: '1rem',
};

const brandKicker: CSSProperties = {
  margin: 0,
  fontSize: '0.7rem',
  color: 'var(--np-text-dim)',
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  fontWeight: 500,
};

const brandTitle: CSSProperties = {
  margin: '0.25rem 0 0',
  fontSize: 'var(--np-t-h1)',
  fontWeight: 600,
  letterSpacing: '-0.03em',
  color: 'var(--np-text)',
  // Por palabras («Luna / Valencia»), no a mitad de una.
  overflowWrap: 'break-word',
};

const userEmail: CSSProperties = {
  display: 'block',
  margin: 0,
  fontSize: '0.875rem',
  fontWeight: 500,
  color: 'var(--np-text)',
};

const userMeta: CSSProperties = {
  display: 'block',
  margin: '0.25rem 0 0',
  fontSize: '0.75rem',
  color: 'var(--np-text-mute)',
};

const code: CSSProperties = {
  fontFamily: 'var(--np-font-mono)',
  background: 'var(--np-surface-2)',
  padding: '0.1rem 0.4rem',
  borderRadius: '4px',
  fontSize: '0.75rem',
};
