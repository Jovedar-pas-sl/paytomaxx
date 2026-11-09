import type { MetadataRoute } from 'next';
import { appManifest } from '@nightpay/ui/app-manifest';

// Abrir como app (pantalla completa, sin la barra del navegador) al añadirla
// a la pantalla de inicio. Next sirve esto en /manifest.webmanifest y lo enlaza solo.
export default function manifest(): MetadataRoute.Manifest {
  return appManifest({
    name: 'OxioPay — TPV',
    shortName: 'OxioPay TPV',
    description: 'Cobrar en la caja del local.',
    orientation: 'portrait',
  });
}
