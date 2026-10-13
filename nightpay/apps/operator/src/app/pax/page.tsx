import type { Metadata } from 'next';
import { PaxScreen } from '@/components/pax/PaxScreen';

export const metadata: Metadata = {
  title: 'NightPay — Datáfono',
};

/** Pantalla del datáfono PAX (dentro de la app NightPay del aparato). */
export default function PaxPage() {
  return <PaxScreen />;
}
