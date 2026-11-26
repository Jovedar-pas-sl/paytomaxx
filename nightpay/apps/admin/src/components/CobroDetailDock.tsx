'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { CobroRow } from '@nightpay/contracts';
import { IconButton, Sheet } from '@nightpay/ui';
import { CobroDetailPanel } from './fichas/CobroDetailPanel';

/** Desde este ancho el detalle va al lado de la lista (panel-cobros.css: .np-cobros-split). */
const DOCK_QUERY = '(min-width: 1280px)';

/** ¿Cabe el detalle al lado? Se mira al montar y al cambiar el tamaño de la ventana. */
export function useDocked(): boolean {
  const [docked, setDocked] = useState(false);
  useEffect(() => {
    const check = () => setDocked(window.matchMedia(DOCK_QUERY).matches);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  return docked;
}

interface Props {
  /** El cobro abierto (la fila de la última respuesta del API), o null. */
  row: CobroRow | null;
  /** Sube tras cada acción (devolver, anular, resolver…): el detalle se vuelve a pedir. */
  version: number;
  /** Los botones del cobro (CobroRowActions), para el pie del detalle. */
  actions: ReactNode;
  docked: boolean;
  onClose: () => void;
}

/**
 * El detalle de un cobro sin tapar la lista. Desde 1280 px, una columna al
 * lado, pegada arriba y con su propio desplazamiento; de 641 a 1279, un panel
 * a la derecha (Sheet); en el móvil, la pantalla entera. Dentro, el mismo
 * detalle de siempre con los botones del cobro en su pie.
 */
export function CobroDetailDock({ row, version, actions, docked, onClose }: Props) {
  if (!row) return null;
  const detail = <CobroDetailPanel key={`${row.kind}:${row.id}:${version}`} row={row} actions={actions} />;
  if (!docked) {
    return (
      <Sheet open onClose={onClose} title="Detalle del cobro" wide="side" full>
        {detail}
      </Sheet>
    );
  }
  return (
    <aside className="np-cobro-dock" aria-label={row.ref ? `Detalle del cobro ${row.ref}` : 'Detalle del cobro'}>
      <div className="np-cobro-dock-head">
        <h2>Detalle del cobro</h2>
        <IconButton icon="close" label="Cerrar el detalle" onClick={onClose} />
      </div>
      {detail}
    </aside>
  );
}
