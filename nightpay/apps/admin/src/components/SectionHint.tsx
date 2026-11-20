'use client';

import { Button } from '@nightpay/ui';
import { sectionHint, type PanelSection, type PanelTab } from '@/lib/roles';

interface Props {
  section: PanelSection;
  /** Las pestañas que ve este rol (el atajo solo sale si ve Reservados). */
  tabs: readonly PanelTab[];
  /** Clientes → Reservados y RRPP, abierto en los RRPP. */
  onOpenRrpp: () => void;
}

/**
 * La línea bajo las pestañas de una sección: lo que hay dentro. En
 * Compañeras, además, el atajo a los RRPP: son personas del equipo, pero se
 * llevan en Clientes → Reservados y RRPP (el dueño no los encontraba).
 */
export function SectionHint({ section, tabs, onOpenRrpp }: Props) {
  const rrpp = section.key === 'chicas' && tabs.some((t) => t.key === 'reservations');
  return (
    <div className="np-section-hint">
      <p>{sectionHint(section.key)}</p>
      {rrpp ? (
        <Button variant="ghost" size="sm" onClick={onOpenRrpp} data-tour="chicas-rrpp">
          RRPP y sus enlaces <span aria-hidden="true">→</span>
        </Button>
      ) : null}
    </div>
  );
}
