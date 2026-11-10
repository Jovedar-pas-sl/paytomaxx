'use client';

import { useCallback, useId, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { browserHelpStorage, createHelpStore } from '../lib/help-line';
import styles from './help-line.module.css';

/**
 * La línea de ayuda de una pantalla del personal (Grafito 2), que se puede
 * cerrar: «Entendido» la esconde en este móvil y el «?» la vuelve a enseñar.
 * Se usa en dos piezas con el mismo `useHelp`: la línea donde va el texto y
 * el «?» junto al título (así no ocupa sitio cuando está cerrada).
 *
 *   const help = useHelp('cobros');
 *   <h2>Mis cobros</h2> <HelpAgain help={help} />
 *   <HelpLine help={help}>Tus cobros, del último al primero…</HelpLine>
 */

const store = createHelpStore(browserHelpStorage);

function subscribe(listener: () => void): () => void {
  const off = store.subscribe(listener);
  // Otra pestaña de la app la cerró o la abrió.
  window.addEventListener('storage', listener);
  return () => {
    off();
    window.removeEventListener('storage', listener);
  };
}

export interface Help {
  hidden: boolean;
  /** «Entendido». */
  hide: () => void;
  /** «?». */
  show: () => void;
  /** Para pasar el foco de una pieza a la otra (el botón que se toca desaparece). */
  okId: string;
  againId: string;
}

/** El foco, al botón que sale en su lugar (cuando ya está pintado). */
function focusSoon(id: string): void {
  requestAnimationFrame(() => document.getElementById(id)?.focus({ preventScroll: true }));
}

/** El estado de la ayuda de una pantalla («cobros», «recepcion-importe»…). En el servidor, se ve. */
export function useHelp(screen: string): Help {
  const hidden = useSyncExternalStore(
    subscribe,
    () => store.isHidden(screen),
    () => false,
  );
  const base = useId();
  const okId = `${base}ok`;
  const againId = `${base}again`;
  const hide = useCallback(() => {
    if (store.hide(screen)) focusSoon(againId);
  }, [screen, againId]);
  const show = useCallback(() => {
    store.show(screen);
    focusSoon(okId);
  }, [screen, okId]);
  return { hidden, hide, show, okId, againId };
}

const cx = (...names: Array<string | undefined>) => names.filter(Boolean).join(' ');

/** La línea (14-16 px, en t2) con «Entendido» al final. Cerrada, nada. */
export function HelpLine({ help, children, className, style }: { help: Help; children: ReactNode; className?: string; style?: CSSProperties }) {
  if (help.hidden) return null;
  return (
    <p className={cx(styles.line, className)} style={style}>
      {children}{' '}
      <button id={help.okId} type="button" className={styles.ok} onClick={help.hide} aria-label="Entendido, ocultar la ayuda">
        Entendido
      </button>
    </p>
  );
}

/** El «?» pequeño para volver a verla. Abierta, nada (la línea ya está a la vista). */
export function HelpAgain({ help, className }: { help: Help; className?: string }) {
  if (!help.hidden) return null;
  return (
    <button id={help.againId} type="button" className={cx(styles.again, className)} onClick={help.show} aria-label="Ver la ayuda">
      ?
    </button>
  );
}
