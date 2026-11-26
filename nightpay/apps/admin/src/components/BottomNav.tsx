'use client';

import { Icon, type IconName } from '@nightpay/ui';
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
    <nav className="np-bottomnav" aria-label="Secciones del panel" data-np-foot="">
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
                  <Icon name={NAV_ICON[item.key]} />
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

/**
 * El dibujo de cada sección (la pieza Icon, a 24). La elegida engorda el trazo
 * por CSS (panel-nav.css: .np-bottomnav-item[aria-current='page'] svg).
 */
const NAV_ICON: Record<SectionKey, IconName> = {
  // Luna: la noche de hoy (cobros y avisos).
  hoy: 'moon',
  chicas: 'users',
  // Tarjeta: el saldo de los clientes.
  clientes: 'card',
  // Barras: informes y noches.
  informes: 'chart',
  ajustes: 'sliders',
  // OxioParty. En directo: el pulso.
  directo: 'activity',
  // Casetas: un toldo con su mostrador.
  casetas: 'store',
  // Pulseras: una pulsera con su chip.
  pulseras: 'wristband',
  // Devoluciones: la flecha que vuelve.
  devoluciones: 'undo',
  // Cierre: la lista con su visto.
  cierre: 'checklist',
};
