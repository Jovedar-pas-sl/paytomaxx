import type { Metadata } from 'next';
import { RrppPage } from '@/components/rrpp/RrppPage';

// «Tus reservas de RRPP» (/rrpp): la tarjeta de Inicio lleva aquí. Con la
// sesión de la app; quien no es RRPP lee qué es esto y vuelve a la app.
export const metadata: Metadata = {
  title: 'Tus reservas de RRPP — OxioPay',
};

export default function Page() {
  return <RrppPage />;
}
