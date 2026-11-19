import type { Metadata } from 'next';
import { PantallaCliente } from '@/components/pantalla/PantallaCliente';

export const metadata: Metadata = {
  title: 'OxioPay — Pantalla del cliente',
};

/** La tablet de la barra que mira al cliente: importe, QR y «Pagado» (sin sesión del personal). */
export default function PantallaPage() {
  return <PantallaCliente />;
}
