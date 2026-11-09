'use client';

// Fallo de una pantalla: un título, qué pasa con lo que estaba a medias y un solo botón.
// Avisa al API para que el dueño se entere (POST /v1/client-errors).
import { useEffect } from 'react';
import { ErrorScreen, reportClientError } from '@nightpay/ui';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

export default function Error({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    reportClientError({ apiBase: API_BASE, app: 'admin', error });
  }, [error]);
  return (
    <ErrorScreen
      title="Esta pantalla del panel ha fallado"
      detail="Lo que ya estaba guardado sigue guardado. Vuelve al panel; si se repite, nos llega el aviso."
      actionLabel="Volver al panel"
      onAction={() => window.location.assign('/')}
    />
  );
}
