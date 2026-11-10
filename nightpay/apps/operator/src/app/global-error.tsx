'use client';

// Fallo en el propio layout: esta pantalla sustituye a todo el <html>.
// Avisa al API para que el dueño se entere (POST /v1/client-errors).
import { useEffect } from 'react';
import { ErrorScreen, reportClientError } from '@nightpay/ui';
import '@nightpay/ui/styles.css';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    reportClientError({ apiBase: API_BASE, app: 'operator', error });
  }, [error]);
  return (
    <html lang="es" data-theme="dark">
      <body>
        <ErrorScreen
          title="Esta pantalla ha fallado"
          detail="Si había un cobro o una recarga a medias, sigue en el servidor: mira Cobros o acerca la ficha antes de cobrar o cargar otra vez."
          actionLabel="Volver a cobrar"
          onAction={() => window.location.assign('/')}
        />
      </body>
    </html>
  );
}
