'use client';

import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { Button } from '@nightpay/ui';
import { Notice } from '../Notice';

// El interruptor que guarda al tocarlo es el común (su resultado, en StatusLine). Lo que espera a «Guardar» es un Checkbox.
export { Switch } from '@nightpay/ui';

/** Un bloque de Ajustes: título, una línea de ayuda y su contenido (`tour`: su marca para el tutorial). */
export function SettingsCard({ title, hint, children, tour }: { title: string; hint?: ReactNode; children: ReactNode; tour?: string }) {
  const titleId = useId();
  return (
    <section className="np-set-card" aria-labelledby={titleId} data-tour={tour}>
      <header className="np-set-head">
        <h2 id={titleId} className="np-set-title">
          {title}
        </h2>
        {hint ? <p className="np-set-hint">{hint}</p> : null}
      </header>
      {children}
    </section>
  );
}

/** Guardar con su resultado al lado («Guardado» un momento, o el error). */
export function SaveRow({
  onSave,
  busy,
  saved,
  error,
  disabled,
  label = 'Guardar',
}: {
  onSave?: () => void;
  busy: boolean;
  saved: boolean;
  error: string | null;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="np-set-save">
      {error ? (
        <p role="alert" className="np-set-error">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="np-set-saved">
          Guardado
        </p>
      ) : null}
      <Button type={onSave ? 'button' : 'submit'} onClick={onSave} loading={busy} disabled={disabled}>
        {label}
      </Button>
    </div>
  );
}

/** El resultado de un cambio que se guarda al tocarlo (interruptores). */
export function StatusLine({ saved, error }: { saved: boolean; error: string | null }) {
  if (error) {
    return (
      <p role="alert" className="np-set-error">
        {error}
      </p>
    );
  }
  return (
    <p role="status" className="np-set-saved">
      {saved ? 'Guardado' : ''}
    </p>
  );
}

/** Carga lo de un ajuste (con «Reintentar» si falla). */
export function useSettingsLoad<T>(load: () => Promise<T>): {
  data: T | null;
  setData: (next: T) => void;
  error: string | null;
  retry: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    load()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
    // `load` es una función de módulo (no cambia): se recarga solo con «Reintentar».
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { data, setData, error, retry };
}

/** «Guardado» durante un momento tras guardar. */
export function useSavedFlash(): [boolean, () => void] {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return undefined;
    const t = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(t);
  }, [saved]);
  return [saved, useCallback(() => setSaved(true), [])];
}

/** Cargando o el error de carga de un ajuste. */
export function LoadState({ error, retry, what }: { error: string | null; retry: () => void; what: string }) {
  return error ? (
    <Notice tone="danger" action={{ label: 'Reintentar', onClick: retry }}>
      No se pudo cargar {what}: {error}
    </Notice>
  ) : (
    <p className="np-set-loading">Cargando…</p>
  );
}
