/** Alto de la barra de pestañas de abajo (sin la zona del indicador de inicio del iPhone). */
export const TAB_BAR_HEIGHT = '4.25rem';

/** Donde se queda pegado el botón de cobrar: justo encima de la barra de pestañas. */
export const STICKY_ACTION_BOTTOM = `calc(${TAB_BAR_HEIGHT} + env(safe-area-inset-bottom, 0px))`;
