'use client';

// Fallo en el propio layout: esta pantalla sustituye a todo el <html>.
// Avisa al API para que el dueño se entere (POST /v1/client-errors).
import { useEffect } from 'react';
import { ErrorScreen, reportClientError } from '@nightpay/ui';
import '@nightpay/ui/styles.css';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    reportClientError({ apiBase: API_BASE, app: 'admin', error });
  }, [error]);
  return (
    <html lang="es" data-theme="dark">
      <body>
        <ErrorScreen
          title="Esta pantalla del panel ha fallado"
          detail="Lo que ya estaba guardado sigue guardado. Vuelve al panel; si se repite, nos llega el aviso."
          actionLabel="Volver al panel"
          onAction={() => window.location.assign('/')}
        />
      </body>
    </html>
  );
}
