// Campos de los filtros del panel (Grafito): 36 px en el escritorio, como los
// botones `sm`, y 44 px con letra de 16 en el móvil (el iPhone no amplía al
// tocarlos). Los valores salen de --np-filter-h y --np-filter-fs
// (styles/panel-nav.css): el Input y el Select de @nightpay/ui ponen su alto
// en línea y solo se cambian pasándoles `style`.

import type { CSSProperties } from 'react';

/** Para `style` de un Input o un Select de un filtro. */
export const FILTER_FIELD: CSSProperties = {
  height: 'var(--np-filter-h)',
  padding: '0 0.75rem',
  fontSize: 'var(--np-filter-fs)',
  borderWidth: '1px',
  borderColor: 'var(--np-border-hi)',
  borderRadius: 'var(--np-r-sm)',
};

/** Un Select de filtro: sitio a la derecha para la flecha. */
export const FILTER_SELECT: CSSProperties = {
  ...FILTER_FIELD,
  paddingRight: '2rem',
  backgroundPosition: 'right 0.75rem center',
};
