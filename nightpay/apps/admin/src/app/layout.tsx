import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import '@nightpay/ui/styles.css';
// Estilos del panel, después de los de @nightpay/ui (pueden ajustar .np-table).
import '../styles/panel-nav.css';
import '../styles/panel-tables.css';
import '../styles/panel-tonight.css';
import '../styles/panel-inbox.css';
import '../styles/panel-otp.css';
import '../styles/panel-close.css';
import '../styles/panel-approvals.css';
import '../styles/panel-settings.css';
import '../styles/panel-money.css';
import '../styles/panel-money-q.css';
import '../styles/panel-carta.css';
// Grafito 3 (escala, lo elegido, interruptores, siluetas): la última, ajusta a las demás.
import '../styles/panel-grafito.css';
import '../styles/panel-vivo.css';
// OxioParty (solo clases np-party-*: con OxioPay no pinta nada).
import '../styles/panel-party.css';
import { appleAppMetadata } from '@nightpay/ui/app-manifest';

// Fuentes dentro del repo (packages/ui/fonts, licencia OFL): el build no
// descarga nada de Google Fonts. Variables, con los mismos pesos de antes.
const sans = localFont({
  src: '../../../../packages/ui/fonts/instrument-sans.woff2',
  weight: '400 700',
  variable: '--font-sans',
  display: 'swap',
});

// Cifras e importes: Manrope variable, en 600 y 700 (Grafito). La variable
// sigue llamándose --font-mono.
const mono = localFont({
  src: '../../../../packages/ui/fonts/manrope-var.woff2',
  weight: '600 800',
  variable: '--font-mono',
  display: 'swap',
});

// Solo las cifras de las tablas del panel (decisión D11): Manrope variable
// 600-800, que panel-tables.css pide en 700.
const monoVar = localFont({
  src: '../../../../packages/ui/fonts/manrope-var.woff2',
  weight: '600 800',
  variable: '--font-mono-var',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'OxioPay — Panel',
  // Añadida a la pantalla de inicio, se abre como app (icono de OxioPay, sin barra del navegador).
  ...appleAppMetadata('OxioPay Panel'),
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Hasta los bordes en iPhone: env(safe-area-inset-*) solo funciona con 'cover'.
  viewportFit: 'cover',
  themeColor: [
    // El fondo de cada tema (--np-bg): grafito y papel.
    { media: '(prefers-color-scheme: dark)', color: '#091518' },
    { media: '(prefers-color-scheme: light)', color: '#f7f5f0' },
  ],
};

const themeInitScript = `(function(){try{var s=localStorage.getItem('np-theme');if(s==='light'||s==='dark'){document.documentElement.setAttribute('data-theme',s);}else if(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches){document.documentElement.setAttribute('data-theme','light');}else{document.documentElement.setAttribute('data-theme','dark');}}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // np-staff: en el móvil, letra y huecos más justos (@nightpay/ui/styles.css).
    <html lang="es" className={`np-staff ${sans.variable} ${mono.variable} ${monoVar.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
