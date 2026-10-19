'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { Button, Logo, ThemeToggle } from '@nightpay/ui';
import { fetchVenueSettings, logout as apiLogout, type User } from '@/lib/api';
import { DEFAULT_TIMEZONE } from '@/lib/dates';
import { visibleTabs, type PanelTab, type TabKey } from '@/lib/roles';
import { IncidentsContext, useIncidentsFeed } from '@/lib/use-incidents';
import { VenueContext, type VenueInfo } from '@/lib/venue-context';
import { BankReconPanel } from './BankReconPanel';
import { BottomNav } from './BottomNav';
import { CartaPanel } from './CartaPanel';
import { IncidentsPanel } from './IncidentsPanel';
import { NightsPanel } from './NightsPanel';
import { OperatorsPanel } from './OperatorsPanel';
import { PaymentsPanel } from './PaymentsPanel';
import { ReportsPanel } from './ReportsPanel';
import { SettingsPanel } from './SettingsPanel';
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

const TABS_ID = 'np-panel';

const ROLE_LABELS: Record<User['role'], string> = {
  OWNER: 'Dueño',
  MANAGER: 'Encargado',
  WAITER: 'Camarero',
  OPERATOR: 'Operadora',
};

export function Dashboard({ user, onLogout }: Props) {
  const tabs = visibleTabs(user);
  const [selected, setSelected] = useState<TabKey>('payments');
  // Una pestaña que este rol no ve nunca se pinta (se vuelve a Pagos).
  const tab = tabs.some((t) => t.key === selected) ? selected : 'payments';
  const venue = useVenueInfo(user);
  const incidents = useIncidentsFeed(user.tenantId, venue.timezone);
  const [loggingOut, setLoggingOut] = useState(false);
  /** Cobro a abrir en Pagos (desde una incidencia: «Abrir cobro»). */
  const [focusPayment, setFocusPayment] = useState<string | null>(null);

  async function logout() {
    setLoggingOut(true);
    onLogout(await apiLogout());
  }

  /** Desde la barra de abajo (o un enlace dentro de un panel): al principio de la sección. */
  function goTo(key: TabKey): void {
    setSelected(key);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
  }

  function openPayment(paymentId: string): void {
    setFocusPayment(paymentId);
    goTo('payments');
  }

  return (
    <VenueContext.Provider value={venue}>
      <IncidentsContext.Provider value={incidents}>
        <main
          className="np-app-root"
          style={{
            minHeight: '100dvh',
            padding: 'clamp(1rem, 4vw, 2rem)',
            maxWidth: '88rem',
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '2rem',
          }}
        >
          <header style={headerStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', minWidth: 0 }}>
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
                <AccountLines user={user} />
              </div>
              <ThemeToggle />
              <Button
                variant="ghost"
                className="np-header-account"
                onClick={() => void logout()}
                loading={loggingOut}
              >
                Salir
              </Button>
            </div>
          </header>

          <TabBar
            tabs={tabs}
            active={tab}
            onChange={setSelected}
            ariaLabel="Secciones del panel"
            idPrefix={TABS_ID}
            className="np-tabbar-main"
          />

          <div
            role="tabpanel"
            className="np-panel-body"
            id={tabPanelId(TABS_ID, tab)}
            aria-labelledby={tabId(TABS_ID, tab)}
            style={{ display: 'flex', flexDirection: 'column', gap: '2rem', minWidth: 0 }}
          >
            <ActivePanel
              tab={tab}
              tabs={tabs}
              user={user}
              onNavigate={goTo}
              onOpenPayment={openPayment}
              focusPayment={focusPayment}
              onFocusPaymentDone={() => setFocusPayment(null)}
            />
          </div>
        </main>

        <BottomNav
          tabs={tabs}
          active={tab}
          onChange={goTo}
          openIncidents={incidents.open ? incidents.open.length : null}
          account={
            <>
              <p>
                <AccountLines user={user} />
              </p>
              <Button variant="ghost" onClick={() => void logout()} loading={loggingOut}>
                Salir
              </Button>
            </>
          }
        />
      </IncidentsContext.Provider>
    </VenueContext.Provider>
  );
}

/** Quién está dentro: email, local y rol. */
function AccountLines({ user }: { user: User }) {
  return (
    <>
      <span style={userEmail}>{user.email}</span>
      <span style={userMeta}>
        <code style={code}>{user.venueSlug}</code> · {ROLE_LABELS[user.role]}
        {user.isSuperAdmin ? ' · super-admin' : ''}
      </span>
    </>
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
}

function ActivePanel({
  tab,
  tabs,
  user,
  onNavigate,
  onOpenPayment,
  focusPayment,
  onFocusPaymentDone,
}: ActivePanelProps) {
  const isOwner = user.role === 'OWNER';
  switch (tab) {
    case 'payments':
      return (
        <PaymentsPanel
          user={user}
          onNavigate={onNavigate}
          focusPaymentId={focusPayment}
          onFocusDone={onFocusPaymentDone}
        />
      );
    case 'nights':
      return <NightsPanel tabs={tabs} onNavigate={onNavigate} />;
    case 'incidents':
      return (
        <IncidentsPanel isOwner={isOwner} tabs={tabs} onNavigate={onNavigate} onOpenPayment={onOpenPayment} />
      );
    case 'bank':
      return <BankReconPanel isOwner={isOwner} />;
    case 'operators':
      return <OperatorsPanel isOwner={isOwner} />;
    case 'carta':
      return <CartaPanel />;
    case 'reports':
      return <ReportsPanel isOwner={isOwner} />;
    case 'wallets':
      return <WalletsPanel isOwner={isOwner} />;
    case 'treasury':
      return <TreasuryPanel isOwner={isOwner} />;
    case 'terminals':
      return <TerminalsPanel isOwner={isOwner} />;
    case 'settings':
      return <SettingsPanel isOwner={isOwner} />;
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
  overflowWrap: 'anywhere',
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
