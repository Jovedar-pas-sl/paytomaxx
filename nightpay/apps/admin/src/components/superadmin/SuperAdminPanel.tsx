'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BusinessView, VenueListItem } from '@nightpay/contracts';
import { fetchTotpStatus, type User } from '@/lib/api';
import { fetchSaBusinesses, fetchSaVenues } from '@/lib/endpoints/superadmin';
import { NOT_ENROLLED_MESSAGE } from '@/lib/superadmin/step-up';
import type { TabKey } from '@/lib/roles';
import '../../styles/panel-superadmin.css';
import { Notice } from '../Notice';
import { TabBar, tabId, tabPanelId, type TabItem } from '../TabBar';
import { AuditSection } from './AuditSection';
import { BusinessesSection } from './BusinessesSection';
import { SaContext, type SaShared } from './context';
import { CustomersSection } from './CustomersSection';
import { PayoutAccountsSection } from './PayoutAccountsSection';
import { PeopleSection } from './PeopleSection';
import { SettlementsSection } from './SettlementsSection';
import { SummarySection } from './SummarySection';
import { VenuesSection } from './VenuesSection';

type SaTab = 'summary' | 'businesses' | 'venues' | 'settlements' | 'people' | 'payouts' | 'customers' | 'audit';

const SA_TABS: readonly TabItem<SaTab>[] = [
  { key: 'summary', label: 'Resumen' },
  { key: 'businesses', label: 'Negocios' },
  { key: 'venues', label: 'Locales' },
  { key: 'settlements', label: 'Liquidaciones' },
  { key: 'people', label: 'Personas' },
  { key: 'payouts', label: 'Cuentas de cobro' },
  { key: 'customers', label: 'Clientes' },
  { key: 'audit', label: 'Registro' },
];

const TABS_ID = 'np-sa';

interface Props {
  user: User;
  /** Ir a otra pestaña del panel (Ajustes, para activar la 2FA). */
  onNavigate: (key: TabKey) => void;
}

/**
 * «Super admin»: la consola de toda la plataforma (solo user.isSuperAdmin).
 * En escritorio es una pestaña; en el móvil, una entrada de «Más». Dentro,
 * sus secciones en pestañas pequeñas.
 */
export function SuperAdminPanel({ user, onNavigate }: Props) {
  const [tab, setTab] = useState<SaTab>('summary');
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [totpEnabled, setTotpEnabled] = useState<boolean | null>(null);
  const [venues, setVenues] = useState<VenueListItem[] | null>(null);
  const [businesses, setBusinesses] = useState<BusinessView[] | null>(null);
  const [listsVersion, setListsVersion] = useState(0);
  const [auditActor, setAuditActor] = useState<{ id: string; label: string } | null>(null);

  // ¿Tiene la 2FA? Sin ella no puede hacer nada delicado: se avisa antes de empezar.
  useEffect(() => {
    let cancelled = false;
    fetchTotpStatus()
      .then((s) => {
        if (!cancelled) setTotpEnabled(s.enabled);
      })
      .catch(() => {
        // Sin respuesta se sabrá al confirmar (TOTP_NOT_ENROLLED).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Locales y negocios para los desplegables de todas las secciones.
  useEffect(() => {
    const controller = new AbortController();
    fetchSaVenues('', controller.signal)
      .then(setVenues)
      .catch(() => {
        if (!controller.signal.aborted) setVenues((prev) => prev ?? []);
      });
    fetchSaBusinesses('', controller.signal)
      .then(setBusinesses)
      .catch(() => {
        if (!controller.signal.aborted) setBusinesses((prev) => prev ?? []);
      });
    return () => controller.abort();
  }, [listsVersion]);

  const goToSettings = useCallback(() => onNavigate('security'), [onNavigate]);
  const refreshLists = useCallback(() => setListsVersion((n) => n + 1), []);
  const openAuditFor = useCallback((actor: { id: string; label: string }) => {
    setAuditActor(actor);
    setTab('audit');
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
  }, []);

  const shared = useMemo<SaShared>(
    () => ({
      currentUserId: user.id,
      currentSlug: user.venueSlug,
      totpEnabled,
      lockedUntil,
      setLockedUntil,
      goToSettings,
      venues,
      businesses,
      refreshLists,
      openAuditFor,
    }),
    [user.id, user.venueSlug, totpEnabled, lockedUntil, goToSettings, venues, businesses, refreshLists, openAuditFor],
  );

  function changeTab(next: SaTab): void {
    if (next !== 'audit') setAuditActor(null);
    setTab(next);
  }

  return (
    <SaContext.Provider value={shared}>
      <div className="np-sa">
        <p className="np-sa-kicker np-sa-area">Super admin</p>
        {totpEnabled === false ? (
          <Notice tone="warning" action={{ label: 'Ir a Ajustes', onClick: goToSettings }}>
            {NOT_ENROLLED_MESSAGE} Mientras, puedes mirar pero no pausar, cambiar reglas, IBAN ni personas.
          </Notice>
        ) : null}
        <TabBar
          tabs={SA_TABS}
          active={tab}
          onChange={changeTab}
          ariaLabel="Secciones de super admin"
          idPrefix={TABS_ID}
          size="sm"
        />
        <div role="tabpanel" id={tabPanelId(TABS_ID, tab)} aria-labelledby={tabId(TABS_ID, tab)} className="np-sa-body">
          <ActiveSection tab={tab} auditActor={auditActor} />
        </div>
      </div>
    </SaContext.Provider>
  );
}

function ActiveSection({ tab, auditActor }: { tab: SaTab; auditActor: { id: string; label: string } | null }) {
  switch (tab) {
    case 'summary':
      return <SummarySection />;
    case 'businesses':
      return <BusinessesSection />;
    case 'venues':
      return <VenuesSection />;
    case 'settlements':
      return <SettlementsSection />;
    case 'people':
      return <PeopleSection />;
    case 'payouts':
      return <PayoutAccountsSection />;
    case 'customers':
      return <CustomersSection />;
    case 'audit':
      return <AuditSection key={auditActor?.id ?? 'all'} actor={auditActor} />;
  }
}
