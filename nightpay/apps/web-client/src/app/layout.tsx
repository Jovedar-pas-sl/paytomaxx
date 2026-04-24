import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'NightPay — Pagar',
  description: 'Paga en segundos acercando la tarjeta al datáfono.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#0b0b10',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body
        style={{
          margin: 0,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          background: '#0b0b10',
          color: '#fafafa',
          minHeight: '100vh',
        }}
      >
        {children}
      </body>
    </html>
  );
}
