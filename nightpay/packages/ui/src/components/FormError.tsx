import type { ReactNode } from 'react';

/**
 * Un error de formulario que se ve (no una línea roja suelta): caja con borde
 * rojo, icono y el texto en el color normal, encima del botón. Va con
 * role="alert" (se anuncia) y con un id para que los campos lo apunten
 * (aria-describedby) y se marquen (aria-invalid).
 */
export function FormError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p role="alert" id={id} className="np-form-error">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5.5M12 16.5h.01" />
      </svg>
      <span>{children}</span>
    </p>
  );
}
