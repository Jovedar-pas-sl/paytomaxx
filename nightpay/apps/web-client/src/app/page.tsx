import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { cx } from './_portada/bits';
import { Footer, Header, Topbar } from './_portada/chrome';
import { Access, Contact, Faq, Party } from './_portada/closing';
import { Hero } from './_portada/Hero';
import { Bitcoin, Clients, HowItWorks, Intro, Venues, Versus } from './_portada/sections';
import s from './landing.module.css';

/**
 * Portada de OxioPay con el aspecto de oxiocard.com (mismo dueño, JOVEDAR PAS
 * S.L.): mismos colores, letra, estilo de logo y tipo de secciones; el
 * contenido es el de OxioPay. Al pago y al saldo se sigue llegando con el
 * enlace del QR (/pay/…, /wallet/…), no desde aquí.
 * Solo cuenta lo que OxioPay hace hoy: sin cifras, reseñas ni promesas.
 * Página estática: sin JavaScript propio (el menú del móvil y las preguntas
 * son <details>).
 */

// Manrope en todos los pesos (400-800), solo en la portada: el layout carga
// Manrope 600-800 para cifras, y aquí hace falta el 400 del texto. Es el
// subconjunto latino de Google Fonts (licencia OFL: packages/ui/fonts/OFL-manrope.txt),
// dentro del repo: el build no descarga nada.
const manrope = localFont({
  src: './_portada/manrope-latin-400-800.woff2',
  weight: '400 800',
  variable: '--font-landing',
  display: 'swap',
});

const TITLE = 'OxioPay — Pagar con el móvil en locales de ocio';
const DESCRIPTION =
  'Escanea el QR del personal y paga desde tu móvil con tarjeta, Apple Pay, Google Pay o tu saldo, sin app ni registro. Carga tu saldo con bitcoin donde lo aceptan.';
const OG_IMAGE = { url: '/portada/og.jpg', width: 1200, height: 630, alt: 'OxioPay: escanea, paga desde tu móvil y sigue la noche' };

/**
 * pay.<dominio>, sacado de NEXT_PUBLIC_API_URL (api.<dominio>), igual que las
 * entradas del personal: así la URL canónica y la imagen para compartir son
 * absolutas. En local no hay dominio y Next usa localhost.
 */
function landingBase(): URL | undefined {
  try {
    const api = new URL(process.env.NEXT_PUBLIC_API_URL ?? '');
    return api.hostname.startsWith('api.') ? new URL(`${api.protocol}//pay.${api.hostname.slice(4)}`) : undefined;
  } catch {
    return undefined;
  }
}

export const metadata: Metadata = {
  metadataBase: landingBase(),
  title: TITLE,
  description: DESCRIPTION,
  // La portada sí se puede encontrar; las páginas de pago siguen fuera de los buscadores (layout).
  robots: { index: true, follow: true },
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    locale: 'es_ES',
    siteName: 'OxioPay',
    url: '/',
    title: TITLE,
    description: DESCRIPTION,
    images: [OG_IMAGE],
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: [OG_IMAGE.url] },
};

// Solo la barra del navegador del móvil, del color de la portada (lo demás, del layout).
export const viewport: Viewport = { themeColor: '#19272b' };

export default function HomePage() {
  return (
    <div className={cx(s.page, manrope.variable)}>
      <a className={s.skip} href="#contenido">
        Saltar al contenido
      </a>
      <Topbar />
      <Header />
      <main id="contenido">
        <Hero />
        <Intro />
        <HowItWorks />
        <Clients />
        <Venues />
        <Bitcoin />
        <Versus />
        <Party />
        <Contact />
        <Faq />
        <Access />
      </main>
      <Footer />
    </div>
  );
}
