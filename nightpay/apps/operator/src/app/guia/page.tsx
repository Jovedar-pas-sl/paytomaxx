import type { Metadata } from 'next';
import { Guia } from '@/components/guia/Guia';

// La «Guía rápida» del personal, en su propia ruta (/guia): se abre desde el
// menú del logo y se puede imprimir desde el navegador. Sin sesión: no enseña
// nada de nadie (las capturas son de la demo, con datos inventados).
export const metadata: Metadata = {
  title: 'Guía rápida — OxioPay',
};

export default function GuiaPage() {
  return <Guia />;
}
