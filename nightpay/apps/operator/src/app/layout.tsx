import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import '@nightpay/ui/styles.css';
// OxioParty: los colores del «Modo día» (solo con <html data-theme="day">).
import './party-day.css';
import { DAY_INIT_SCRIPT } from '@/lib/day-mode';
import { isParty } from '@/lib/edition';
import { SALA_INIT_SCRIPT } from '@/lib/sala-contrast';
import { appleAppMetadata } from '@nightpay/ui/app-manifest';
import { deviceInitScript } from '@nightpay/ui/device-settings';
import { BrandSplash } from '@nightpay/ui/brand-splash';
import { NfcEscucha } from '@/components/NfcEscucha';
import { PracticeBand } from '@/components/PracticeBand';

// Fuentes dentro del repo (packages/ui/fonts, licencia OFL): el build no
// descarga nada de Google Fonts. Variables, con los mismos pesos de antes.
const sans = localFont({
  src: '../../../../packages/ui/fonts/instrument-sans.woff2',
  weight: '400 700',
  variable: '--font-sans',
  display: 'swap',
});

// Cifras, importes y títulos: Manrope 800 (marca OxioCard). La variable
// sigue llamándose --font-mono.
const mono = localFont({
  src: '../../../../packages/ui/fonts/manrope-var.woff2',
  weight: '600 800',
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'OxioPay — Personal',
  // Añadida a la pantalla de inicio, se abre como app (icono de OxioPay, sin barra del navegador).
  ...appleAppMetadata('OxioPay'),
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Hasta los bordes en iPhone: env(safe-area-inset-*) solo funciona con 'cover'.
  viewportFit: 'cover',
  themeColor: '#091518',
};

// Oscuro (Grafito) de partida: dentro del local, un móvil en modo claro enseñaba
// la crema a toda luz. Quien lo cambia en «Mi perfil» (claro o como el móvil)
// lo recuerda este móvil (np-theme), igual que la letra más grande. Y, si el
// local lo tiene, el modo «sala» (contraste alto): antes de pintar, para que
// no cambie al cargar. En OxioParty, además, el «Modo día» de este móvil
// (después del tema: lo sustituye).
const themeInitScript = `${SALA_INIT_SCRIPT}${deviceInitScript('dark')}${isParty() ? DAY_INIT_SCRIPT : ''}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // np-staff: en el móvil, letra y huecos más justos (@nightpay/ui/styles.css).
    <html lang="es" data-theme="dark" className={`np-staff np-touch ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <BrandSplash />
        {/* «Modo práctica»: la franja fija de arriba (solo mientras se practica). */}
        <PracticeBand />
        {children}
        {/* Una sola escucha NFC para toda la app: Android no abre el enlace de la ficha. */}
        <NfcEscucha />
      </body>
    </html>
  );
}
