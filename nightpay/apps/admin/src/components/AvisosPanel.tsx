'use client';

import { useEffect, useState } from 'react';
import { decidableCount } from '@/lib/approvals';
import { inboxHiddenKinds } from '@/lib/bottom-nav';
import type { PanelTab, TabKey } from '@/lib/roles';
import { useApprovals } from '@/lib/use-approvals';
import { ApprovalsPanel } from './ApprovalsPanel';
import { IncidentsPanel } from './IncidentsPanel';
import { MyRequestsPanel } from './MyRequestsPanel';

interface Props {
  isOwner: boolean;
  tabs: readonly PanelTab[];
  onNavigate: (key: TabKey) => void;
  onOpenPayment: (paymentId: string) => void;
}

/**
 * Hoy → Avisos: una sola bandeja. Arriba lo que espera una decisión (el
 * dueño aprueba o rechaza; el encargado ve lo que pidió) y debajo las
 * incidencias abiertas. El globo de «Hoy» cuenta las dos cosas.
 */
export function AvisosPanel({ isOwner, tabs, onNavigate, onOpenPayment }: Props) {
  const approvals = useApprovals();
  const pending = decidableCount(approvals.pending) ?? 0;
  // Una vez enseñadas las tarjetas, se quedan mientras se mira (al aprobar la
  // última se ve el resultado en vez de desaparecer todo de golpe).
  const [showApprovals, setShowApprovals] = useState(false);
  useEffect(() => {
    if (pending > 0) setShowApprovals(true);
  }, [pending]);

  return (
    <div className="np-avisos">
      {isOwner && (showApprovals || pending > 0) ? <ApprovalsPanel /> : null}
      {isOwner ? null : <MyRequestsPanel hideWhenEmpty />}
      <IncidentsPanel
        isOwner={isOwner}
        tabs={tabs}
        onNavigate={onNavigate}
        onOpenPayment={onOpenPayment}
        hiddenKinds={inboxHiddenKinds(isOwner)}
      />
    </div>
  );
}
