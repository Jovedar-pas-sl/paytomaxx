/**
 * Alto de la barra de pestañas de abajo (sin la zona del indicador de inicio
 * del iPhone). En el móvil, según el alto de la pantalla (--np-tabbar-h, en
 * @nightpay/ui/staff.css).
 */
export const TAB_BAR_HEIGHT = 'var(--np-tabbar-h, 4.25rem)';

/** Donde se queda pegado el botón de cobrar: justo encima de la barra de pestañas. */
export const STICKY_ACTION_BOTTOM = `calc(${TAB_BAR_HEIGHT} + env(safe-area-inset-bottom, 0px))`;
