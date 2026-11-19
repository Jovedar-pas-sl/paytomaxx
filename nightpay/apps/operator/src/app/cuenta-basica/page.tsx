import type { Metadata } from 'next';
import { CuentaBasica } from '@/components/guia/CuentaBasica';

// La guía de la cuenta de pago básica (/cuenta-basica): se abre desde el alta
// («No tengo cuenta: quiero abrir una») y desde «Ganancias». Sin sesión: no
// enseña nada de nadie.
export const metadata: Metadata = {
  title: 'Cuenta de pago básica — OxioPay',
};

export default function CuentaBasicaPage() {
  return <CuentaBasica />;
}
