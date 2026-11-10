'use client';

import { useEffect, useState } from 'react';
import { CASH_TOP_UP_UNDO_SECONDS } from '@nightpay/contracts';
import { formatEur } from '@/lib/money';
import { CASH_UNDO_REASON_LABEL, UNDO_REASON_NEXT, undoOpen, undoneText, type CashUndoReason } from '@/lib/cash-undo';
import { DeskBtn, DeskRowLink, FichaNumber, NfcMark } from './desk-parts';
import s from './desk.module.css';
import l from './loaded.module.css';

/**
 * «Me he equivocado» debajo de los botones de CARGADO (B4): solo los 2
 * minutos siguientes; luego desaparece (lo anula el encargado).
 */
export function UndoLink({ loadedAt, onUndo }: { loadedAt: number; onUndo: () => void }) {
  const [open, setOpen] = useState(() => undoOpen(loadedAt, Date.now()));
  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => setOpen(false), Math.max(0, loadedAt + CASH_TOP_UP_UNDO_SECONDS * 1000 - Date.now()));
    return () => clearTimeout(timer);
  }, [open, loadedAt]);
  if (!open) return null;
  return (
    <button type="button" className={l.undoLink} onClick={onUndo}>
      Me he equivocado
    </button>
  );
}

/**
 * «Me he equivocado» en la primera pantalla de recepción (B4): la recarga en
 * efectivo sigue a mano sus 2 minutos aunque CARGADO ya se haya cerrado (con
 * B3 la siguiente ficha lo cierra enseguida, justo en «Ficha equivocada»).
 * `label`: «50 € · ficha 1013». Se va sola al acabar el plazo.
 */
export function UndoRow({ loadedAt, label, onUndo }: { loadedAt: number; label: string; onUndo: () => void }) {
  const [open, setOpen] = useState(() => undoOpen(loadedAt, Date.now()));
  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => setOpen(false), Math.max(0, loadedAt + CASH_TOP_UP_UNDO_SECONDS * 1000 - Date.now()));
    return () => clearTimeout(timer);
  }, [open, loadedAt]);
  if (!open) return null;
  return <DeskRowLink label={`Me he equivocado: ${label}`} onClick={onUndo} />;
}

/**
 * B4: primero el motivo (los tres del dueño) y después la misma ficha. Otra
 * ficha no vale (solo avisa). Se anula solo si el saldo aún la cubre.
 */
export function UndoStep(props: {
  reason: CashUndoReason | null;
  /** Lo que se anula: el saldo + la comisión del servicio. */
  chargeCents: number;
  ficha: string | null;
  busy: boolean;
  onReason: (reason: CashUndoReason | null) => void;
}) {
  if (!props.reason) {
    return (
      <>
        <p className={s.q}>¿Qué ha pasado?</p>
        <p className={s.hint}>Se anula la recarga de {formatEur(props.chargeCents, { compact: true })}. Queda apuntado en Incidencias.</p>
        {(Object.keys(CASH_UNDO_REASON_LABEL) as CashUndoReason[]).map((reason) => (
          <DeskBtn key={reason} kind="gho" label={CASH_UNDO_REASON_LABEL[reason]} small={UNDO_REASON_NEXT[reason]} onClick={() => props.onReason(reason)} />
        ))}
      </>
    );
  }
  return (
    <>
      <div className={s.stage}>
        <NfcMark size="l" />
        <div className={s.stageLive} aria-live="polite" aria-busy={props.busy || undefined}>
          <p className={s.stageTitle}>{props.busy ? 'Anulando…' : 'Acerca la misma ficha'}</p>
          {props.ficha ? <FichaNumber printed={props.ficha} className={s.cobroFicha} /> : null}
          <p className={s.stageText}>
            Para anular la recarga de {formatEur(props.chargeCents, { compact: true })} ({CASH_UNDO_REASON_LABEL[props.reason]}). Otra ficha no vale.
          </p>
        </div>
      </div>
      <DeskBtn kind="gho" label="Cambiar el motivo" onClick={() => props.onReason(null)} disabled={props.busy} />
    </>
  );
}

/** Anulada (B4): qué hacer ahora con el efectivo y la ficha. */
export function UndoneStep({ reason, cents, onNext }: { reason: CashUndoReason; cents: number; onNext: () => void }) {
  return (
    <>
      <p className={s.q} role="status">
        Recarga anulada
      </p>
      <p className={s.hint}>{undoneText(reason, cents)}</p>
      <DeskBtn kind="pri" label="Siguiente cliente" onClick={onNext} />
    </>
  );
}
