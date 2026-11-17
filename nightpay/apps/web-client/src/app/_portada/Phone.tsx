import type { Shot } from './content';
import h from './hero.module.css';

interface PhoneProps {
  shot: Shot;
  className?: string;
  /**
   * Las de arriba del todo se cargan ya ('eager'; la principal, además, con
   * prioridad: 'high'). Sin esto, perezosa: todo lo que va debajo del hero.
   */
  load?: 'high' | 'eager';
}

/**
 * Una captura real de la app dentro de un móvil dibujado con CSS. El marco
 * (bordes y botón) es decoración que los lectores de pantalla no leen; la
 * captura lleva su texto alternativo corto. Su ancho lo pone `className` con
 * la variable --pw.
 */
export function Phone({ shot, className, load }: PhoneProps) {
  return (
    <div className={className ? `${h.phone} ${className}` : h.phone}>
      <img
        src={shot.src}
        width={shot.width}
        height={shot.height}
        alt={shot.alt}
        loading={load ? 'eager' : 'lazy'}
        fetchPriority={load === 'high' ? 'high' : undefined}
        decoding="async"
      />
    </div>
  );
}
