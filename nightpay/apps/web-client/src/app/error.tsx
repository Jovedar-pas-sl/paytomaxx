'use client';

// Fallo de una pantalla: qué hacer y un solo botón, en el idioma del navegador.
// Avisa al API para que el dueño se entere (POST /v1/client-errors).
import { useEffect } from 'react';
import { ErrorScreen, reportClientError } from '@nightpay/ui';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4100';

const TEXT = {
  es: { title: 'Algo ha fallado', detail: 'Si ya habías pagado, no pagues otra vez: pregunta al personal.', action: 'Volver a intentarlo' },
  en: { title: 'Something went wrong', detail: 'If you had already paid, do not pay again: ask the staff.', action: 'Try again' },
  fr: { title: 'Un problème est survenu', detail: 'Si vous aviez déjà payé, ne payez pas une deuxième fois : demandez au personnel.', action: 'Réessayer' },
  pt: { title: 'Algo correu mal', detail: 'Se já tinha pago, não pague outra vez: pergunte ao pessoal.', action: 'Tentar outra vez' },
} as const;

function textFor(): (typeof TEXT)[keyof typeof TEXT] {
  const lang = typeof navigator === 'undefined' ? 'es' : navigator.language.slice(0, 2);
  return lang === 'en' || lang === 'fr' || lang === 'pt' ? TEXT[lang] : TEXT.es;
}

export default function Error({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    reportClientError({ apiBase: API_BASE, app: 'web-client', error });
  }, [error]);
  const t = textFor();
  const screen = <ErrorScreen title={t.title} detail={t.detail} actionLabel={t.action} onAction={() => window.location.reload()} />;
  return screen;
}
