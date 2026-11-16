/**
 * Alto de la barra de pestañas de abajo (sin la zona del indicador de inicio
 * del iPhone). En el móvil, según el alto de la pantalla (--np-tabbar-h, en
 * @nightpay/ui/staff.css).
 */
export const TAB_BAR_HEIGHT = 'var(--np-tabbar-h, 4.25rem)';

/**
 * Lo que ocupa de verdad la barra de abajo, con la zona segura: lo mide la
 * propia barra (--np-tabbar-space, TabBar) porque en un datáfono con los
 * botones de Android, o con la letra más grande, puede ocupar más de lo
 * previsto. Hasta medirla, la cuenta de siempre.
 */
export const TAB_BAR_SPACE = `var(--np-tabbar-space, calc(${TAB_BAR_HEIGHT} + env(safe-area-inset-bottom, 0px)))`;

/** Donde se queda pegado el botón de cobrar: justo encima de la barra de pestañas. */
export const STICKY_ACTION_BOTTOM = TAB_BAR_SPACE;

/** El hueco al final de cada página: la barra, la zona segura y un respiro para que lo último se vea entero. */
export const PAGE_BOTTOM_SPACE = `calc(${TAB_BAR_SPACE} + 1.5rem)`;
