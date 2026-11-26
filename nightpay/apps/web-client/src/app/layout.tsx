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

// Cifras: Manrope variable 600-700 (Grafito). La variable sigue llamándose
// --font-mono.
const mono = localFont({
  src: '../../../../packages/ui/fonts/manrope-var.woff2',
  weight: '600 800',
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'OxioPay — Pagar',
  description: 'Paga desde el móvil escaneando el QR del local.',
  // Como las páginas de pago del API: fuera de los buscadores.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Hasta los bordes en iPhone: env(safe-area-inset-*) solo funciona con 'cover'.
  viewportFit: 'cover',
  themeColor: '#091518',
};

// Siempre oscuro, como las páginas de pago del API (Grafito: el claro queda
// para el panel). Sin script de tema: nada que cambie al cargar.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" data-theme="dark" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
