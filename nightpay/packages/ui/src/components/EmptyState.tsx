import type { ReactNode } from 'react';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';

interface EmptyStateProps {
  /** El icono del juego común (28 px en un círculo de 72; 20 px sin círculo en `compact`). */
  icon?: IconName;
  /** Un dibujo propio en lugar del icono. */
  art?: ReactNode;
  /** La frase: qué pasa aquí cuando no hay nada («Aún no has cobrado esta noche»). */
  title: string;
  /** Qué se verá cuando lo haya. */
  text?: string;
  /** UN botón, secundario salvo `primary`. */
  action?: { label: string; onClick: () => void; primary?: boolean };
  /** Para un hueco pequeño (una tarjeta, una columna): icono de 20 sin círculo, frase más corta y sin botón. */
  compact?: boolean;
}

/** Una pantalla o una lista sin nada todavía: dibujo, frase y, si hay algo que hacer, un botón (estilos en pieces.css: .np-empty). */
export function EmptyState({ icon, art, title, text, action, compact = false }: EmptyStateProps) {
  return (
    <div className="np-empty" data-compact={compact ? '' : undefined}>
      {art ??
        (icon ? (
          compact ? (
            <Icon name={icon} size={20} />
          ) : (
            <span className="np-empty-icon">
              <Icon name={icon} size={28} />
            </span>
          )
        ) : null)}
      <p className="np-empty-title">{title}</p>
      {text ? <p className="np-empty-text">{text}</p> : null}
      {action && !compact ? (
        <Button size="md" variant={action.primary ? 'primary' : 'ghost'} onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
