'use client';

import type { OperatorUser } from '@/lib/api';
import { ReceptionDesk } from './desk/ReceptionDesk';
import { useShown } from './desk/use-shown';
import s from './desk/desk.module.css';

/**
 * Inicio → «Recargar saldo» (estudio de fichas, B12): las mismas pantallas que
 * el mostrador de Recepción (la ficha y su número en grande, el efectivo con
 * la misma ficha, CARGADO…), para quien carga saldos sin estar en Recepción,
 * con sus mismos permisos de efectivo (los dice el servidor). Solo la entrada:
 * la salida, los pendientes y preparar fichas siguen en Recepción. El lector,
 * solo con Inicio a la vista (en otra pestaña lo usaría a la vez).
 */
export function HomeTopUpDesk({ user, onExit, onDone }: { user: OperatorUser; onExit: () => void; onDone: () => void }) {
  const [shownRef, shown] = useShown();
  return (
    <div ref={shownRef} className={s.screen}>
      <ReceptionDesk user={user} active={shown} footer={null} home={{ onExit, onDone }} />
    </div>
  );
}