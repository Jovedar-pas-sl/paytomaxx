/**
 * El manifiesto de app (app/manifest.ts de cada web): con él, «Añadir a la
 * pantalla de inicio» (iPhone) o «Instalar aplicación» (Android) abre la web
 * a pantalla completa, sin la barra del navegador, con el icono de OxioPay.
 * Los iconos están en public/icons de cada app.
 */
export const APP_ICONS = {
  icon192: '/icons/icon-192.png',
  icon512: '/icons/icon-512.png',
  maskable512: '/icons/icon-maskable-512.png',
  apple: '/icons/apple-touch-icon.png',
} as const;

/** Fondo y barra del sistema: el de Grafito, para que al abrir no salga un destello blanco. */
export const APP_BACKGROUND = '#0b0d0e';

export interface AppManifestInput {
  /** Nombre entero («OxioPay — Personal»). */
  name: string;
  /** Debajo del icono (corto: cabe en una línea). */
  shortName: string;
  description: string;
  /** El personal y el TPV, siempre en vertical; el panel, como venga. */
  orientation?: 'portrait' | 'any';
}

export function appManifest({ name, shortName, description, orientation = 'portrait' }: AppManifestInput) {
  return {
    name,
    short_name: shortName,
    description,
    lang: 'es',
    start_url: '/',
    scope: '/',
    display: 'standalone' as const,
    orientation,
    background_color: APP_BACKGROUND,
    theme_color: APP_BACKGROUND,
    icons: [
      { src: APP_ICONS.icon192, sizes: '192x192', type: 'image/png' },
      { src: APP_ICONS.icon512, sizes: '512x512', type: 'image/png' },
      { src: APP_ICONS.maskable512, sizes: '512x512', type: 'image/png', purpose: 'maskable' as const },
    ],
  };
}

/** Lo que va en `metadata` del layout: el icono del iPhone y que se abra como app. */
export function appleAppMetadata(title: string) {
  return {
    appleWebApp: { capable: true, title, statusBarStyle: 'black' as const },
    icons: {
      icon: [{ url: APP_ICONS.icon192, sizes: '192x192', type: 'image/png' }],
      apple: [{ url: APP_ICONS.apple, sizes: '180x180', type: 'image/png' }],
    },
  };
}
