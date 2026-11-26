import type { ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * Un error de formulario que se ve (no una línea roja suelta): caja con borde
 * rojo, icono y el texto en el color normal, encima del botón. Va con
 * role="alert" (se anuncia) y con un id para que los campos lo apunten
 * (aria-describedby) y se marquen (aria-invalid).
 */
export function FormError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p role="alert" id={id} className="np-form-error">
      <Icon name="alert" size={20} />
      <span>{children}</span>
    </p>
  );
}
