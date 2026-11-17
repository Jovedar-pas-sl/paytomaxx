'use client';

import { formatEur } from '@/lib/money';
import { EXIT_RULE, entryRow, type NumberSaldo } from '@/lib/reception-desk';
import { DeskBtn, DeskRowView } from './desk-parts';
import s from './desk.module.css';

const eur = (cents: number) => formatEur(cents, { compact: true });

/**
 * Salida por el número impreso: se ve lo que tiene (con el código tapado) y
 * se guarda para la próxima. El saldo no se devuelve (decisión del dueño,
 * 17-nov-2026): la regla, donde antes estaba «Devolver en efectivo».
 */
export function NumberExitStep({ view, onKeep }: { view: NumberSaldo; onKeep: () => void }) {
  // Por su número (A6): en grande, «Compruébalo con la ficha» y lo que se le pregunta.
  const row = entryRow({ view: null, nfc: null, number: view });
  return (
    <>
      <DeskRowView title={row.title} detail={row.detail} ficha={row.ficha}>
        <span className={s.rowHint}>{row.hint}</span>
        <span className={s.rowHint}>{row.ask}</span>
      </DeskRowView>
      <div className={s.bigamt} data-tour="recep-quedan">
        <span className={s.kick}>{view.balanceCents > 0 ? 'Le quedan' : 'No le queda saldo'}</span>
        <p className={s.bignum}>{eur(view.balanceCents)}</p>
      </div>
      <DeskBtn kind="pri" label="Guardar para la próxima" small="Para otra noche · se lleva su ficha" onClick={onKeep} tour="recep-guardar" />
      {view.balanceCents > 0 ? (
        <p className={s.lbl} data-tour="recep-regla">
          {EXIT_RULE}
        </p>
      ) : null}
    </>
  );
}
