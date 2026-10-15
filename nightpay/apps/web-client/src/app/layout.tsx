import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import '@nightpay/ui/styles.css';

// Fuentes dentro del repo (packages/ui/fonts, licencia OFL): el build no
// descarga nada de Google Fonts. Variables, con los mismos pesos de antes.
const sans = localFont({
  src: '../../../../packages/ui/fonts/instrument-sans.woff2',
  weight: '400 700',
  variable: '--font-sans',
  display: 'swap',
});

// Cifras e importes (look "Club"). La variable sigue llamándose --font-mono.
const mono = localFont({
  src: '../../../../packages/ui/fonts/unbounded.woff2',
  weight: '500 700',
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'OxioPay — Pagar',
  description: 'Paga en segundos acercando la tarjeta al datáfono.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Hasta los bordes en iPhone: env(safe-area-inset-*) solo funciona con 'cover'.
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0b0b0b' },
    { media: '(prefers-color-scheme: light)', color: '#f4f4ef' },
  ],
};

const themeInitScript = `(function(){try{var s=localStorage.getItem('np-theme');if(s==='light'||s==='dark'){document.documentElement.setAttribute('data-theme',s);}else if(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches){document.documentElement.setAttribute('data-theme','light');}else{document.documentElement.setAttribute('data-theme','dark');}}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
