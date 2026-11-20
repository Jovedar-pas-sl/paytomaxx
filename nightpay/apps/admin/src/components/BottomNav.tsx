'use client';

import { bottomNavItems, navBadge } from '@/lib/bottom-nav';
import type { PanelSection, SectionKey } from '@/lib/roles';

interface Props {
  sections: readonly PanelSection[];
  active: SectionKey;
  onChange: (key: SectionKey) => void;
  /** Lo que hay en Avisos (incidencias + por aprobar); null = aún no se sabe. */
  avisos: number | null;
}

/**
 * Barra fija de abajo en el móvil (en escritorio no se pinta: styles/panel-nav.css):
 * Hoy · Chicas · Clientes · Informes · Ajustes. Sin «Más»: cada sección
 * tiene dentro sus pestañas; la cuenta y «Salir» están en Ajustes → Seguridad.
 */
export function BottomNav({ sections, active, onChange, avisos }: Props) {
  return (
    <nav className="np-bottomnav" aria-label="Secciones del panel">
      <ul>
        {bottomNavItems(sections).map((item) => {
          const badge = navBadge(item.key, avisos);
          return (
            <li key={item.key}>
              <button
                type="button"
                className="np-bottomnav-item"
                aria-current={item.key === active ? 'page' : undefined}
                onClick={() => onChange(item.key)}
              >
                <span className="np-bottomnav-icon">
                  <NavIcon name={item.key} />
                  {badge ? (
                    <span className="np-bottomnav-badge" aria-hidden="true">
                      {badge.text}
                    </span>
                  ) : null}
                </span>
                <span className="np-bottomnav-label">{item.label}</span>
                {badge ? <span className="np-sr-only">, {badge.spoken}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const ICON_PATHS: Record<SectionKey, string> = {
  // Luna: la noche de hoy (cobros y avisos).
  hoy: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  chicas:
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.5a6.5 6.5 0 0 1 3.5 5.5',
  // Tarjeta: el saldo de los clientes.
  clientes: 'M3 7h18v10H3zM3 11h18M7 15h3',
  // Barras: informes y noches.
  informes: 'M5 20V11M12 20V5M19 20v-6M3 20h18',
  // Ajustes: tres controles deslizantes.
  ajustes: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4',
  // OxioParty. En directo: el pulso.
  directo: 'M3 12h4l3-7 4 14 3-7h4',
  // Casetas: un toldo con su mostrador.
  casetas: 'M4 10l2-6h12l2 6M4 10h16M4 10a2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0M5 12v8h14v-8M10 20v-5h4v5',
  // Pulseras: una pulsera con su chip.
  pulseras: 'M12 4a8 4 0 1 0 0 16 8 4 0 1 0 0-16zM10 10h4v4h-4z',
  // Devoluciones: la flecha que vuelve.
  devoluciones: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  // Cierre: la lista con su visto.
  cierre: 'M9 5h10M9 12h10M9 19h10M4 5l1 1 2-2M4 12l1 1 2-2M4 19l1 1 2-2',
};

function NavIcon({ name }: { name: SectionKey }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
