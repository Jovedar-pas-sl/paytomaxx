'use client';

import { useEffect, useId, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Button } from '@nightpay/ui';
import { Notice } from '../Notice';
import type { Loaded } from './use-load';

/** Cabecera de una sección o ficha: rótulo pequeño, título grande y acciones. */
export function SectionHead({
  kicker,
  title,
  sub,
  actions,
  level = 2,
}: {
  kicker?: string;
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  level?: 2 | 3;
}) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <header className="np-sa-head">
      <div className="np-sa-head-text">
        {kicker ? <p className="np-sa-kicker">{kicker}</p> : null}
        <Heading className={level === 2 ? 'np-sa-title' : 'np-sa-subtitle'}>{title}</Heading>
        {sub ? <p className="np-sa-sub">{sub}</p> : null}
      </div>
      {actions ? <div className="np-sa-head-actions">{actions}</div> : null}
    </header>
  );
}

/**
 * Cargando / error con «Reintentar» / datos. Con datos ya pintados, un fallo
 * al refrescar se avisa encima sin quitar lo que se veía.
 */
export function LoadGate<T>({
  loaded,
  what,
  children,
}: {
  loaded: Loaded<T>;
  /** "los negocios": para «Cargando los negocios…». */
  what: string;
  children: (data: T) => ReactNode;
}) {
  const { data, error, loading, reload } = loaded;
  if (data === null) {
    if (error) {
      return (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: reload }}>
          No se pudieron cargar {what}: {error}
        </Notice>
      );
    }
    return (
      <p className="np-sa-loading" role="status">
        {loading ? `Cargando ${what}…` : ''}
      </p>
    );
  }
  return (
    <>
      {error ? (
        <Notice tone="warning" action={{ label: 'Reintentar', onClick: reload }}>
          No se pudo actualizar: {error}
        </Notice>
      ) : null}
      {children(data)}
    </>
  );
}

/** Cifra grande (Manrope 800) con su rótulo. Va dentro de <dl className="np-sa-figs">. */
export function Figure({
  label,
  value,
  note,
  hero,
  alert,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  hero?: boolean;
  alert?: boolean;
}) {
  return (
    <div className="np-sa-fig" data-hero={hero ? 'true' : undefined} data-alert={alert ? 'true' : undefined}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      {note ? <span className="np-sa-fig-note">{note}</span> : null}
    </div>
  );
}

/** Botón pequeño (filas de tablas, fichas). */
export function SmallButton({
  variant = 'ghost',
  loading,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger';
  loading?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      loading={loading}
      className={['np-sa-sm', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </Button>
  );
}

const COPIED_MS = 2000;

/** Copiar al portapapeles, con «Copiado» unos segundos. */
export function CopyButton({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return undefined;
    const timer = setTimeout(() => setState('idle'), COPIED_MS);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <SmallButton onClick={() => void copy()} aria-live="polite">
      {state === 'copied' ? 'Copiado' : state === 'failed' ? 'Cópialo a mano' : label}
    </SmallButton>
  );
}

/** Algo que hay que pasar a alguien (enlace, contraseña): grande, entero y con «Copiar». */
export function SecretBox({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div className="np-sa-secret" data-big={big ? 'true' : undefined}>
      <span className="np-sa-kicker">{label}</span>
      <code className="np-sa-secret-value">{value}</code>
      <CopyButton text={value} />
    </div>
  );
}

/** «← Volver a la lista». */
export function BackButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="np-sa-back" onClick={onClick}>
      <span aria-hidden="true">←</span> {children}
    </button>
  );
}

/** Lista «rótulo: valor» de una ficha. */
export function MetaList({ items }: { items: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="np-sa-meta">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Casilla con su explicación debajo. */
export function CheckRow({
  checked,
  onChange,
  label,
  help,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  help?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="np-sa-check">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
      <span>
        <span className="np-sa-check-label">{label}</span>
        {help ? <span className="np-sa-help">{help}</span> : null}
      </span>
    </label>
  );
}

export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="np-sa-error">
      {children}
    </p>
  );
}

/** Explicación en llano debajo de un campo o una regla. */
export function Help({ children }: { children: ReactNode }) {
  return <p className="np-sa-help">{children}</p>;
}

/**
 * Botones de un formulario: pegados abajo (en el móvil, encima de la barra),
 * a mano del pulgar mientras el formulario se ve. `sticky={false}` en fichas
 * cortas.
 */
export function StickyActions({ children, sticky = true }: { children: ReactNode; sticky?: boolean }) {
  return (
    <div className="np-sa-actions" data-sticky={sticky ? 'true' : undefined}>
      {children}
    </div>
  );
}
