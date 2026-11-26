'use client';

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Sheet } from './Sheet';

interface ConfirmDialogProps {
  open: boolean;
  /** La pregunta: «¿Bloquear la ficha 522?». */
  title: string;
  /** La consecuencia, en una frase: «Ya no podrá pagar con ella.». */
  children?: ReactNode;
  /** Verbo + cosa: «Bloquear ficha» (nunca «Sí» ni «Aceptar»). */
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` (por defecto): no se deshace. `primary`: solo conviene confirmarlo. */
  tone?: 'danger' | 'primary';
  /** Mientras se hace: la acción trabajando, «Volver» apagado y nada la cierra. */
  busy?: boolean;
  busyLabel?: string;
  /** No la cierra: la cierra quien la usa cuando termina (o enseña su error). */
  onConfirm: () => void;
  onClose: () => void;
}

const stay = () => undefined;

/**
 * La pregunta antes de lo que no se deshace o mueve dinero. Es una hoja
 * (Sheet) con role="alertdialog": «Volver» va primero y con el foco, así
 * Intro sin mirar no hace lo peligroso. Hasta 640 px, los dos botones a lo
 * ancho con la acción arriba; desde 641, lado a lado (estilos en pieces-2.css).
 */
export function ConfirmDialog({ open, title, children, confirmLabel, cancelLabel = 'Volver', tone = 'danger', busy = false, busyLabel, onConfirm, onClose }: ConfirmDialogProps) {
  const textId = useId();
  return (
    <Sheet
      open={open}
      onClose={busy ? stay : onClose}
      title={title}
      width="26rem"
      role="alertdialog"
      describedBy={children ? textId : undefined}
      footer={
        <div className="np-pregunta-pie">
          <Button variant="ghost" size="lg" autoFocus disabled={busy} onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button variant={tone} size="lg" loading={busy} loadingLabel={busyLabel} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      }
    >
      {children ? (
        <p id={textId} className="np-pregunta-texto">
          {children}
        </p>
      ) : null}
    </Sheet>
  );
}

export interface ConfirmQuestion {
  title: string;
  /** La consecuencia. */
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
}

/**
 * La pregunta, como una promesa:
 *
 *   const [confirm, dialog] = useConfirm();
 *   if (!(await confirm({ title, body, confirmLabel }))) return;
 *   …
 *   return <>{…}{dialog}</>;
 *
 * `dialog` es `null` mientras no se pregunta. Un toque la cierra y responde
 * UNA vez (true: la acción; false: «Volver», Esc, la ✕ o «atrás»). Otra
 * pregunta da false a la que estuviera abierta.
 */
export function useConfirm(): [confirm: (question: ConfirmQuestion) => Promise<boolean>, dialog: ReactNode] {
  const [question, setQuestion] = useState<ConfirmQuestion | null>(null);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  const answer = useCallback((ok: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    resolve?.(ok);
    setQuestion(null);
  }, []);

  const confirm = useCallback(
    (next: ConfirmQuestion) =>
      new Promise<boolean>((resolve) => {
        pending.current?.(false);
        pending.current = resolve;
        setQuestion(next);
      }),
    [],
  );

  // Si la pantalla se va con la pregunta abierta, quien espera recibe su «no».
  useEffect(() => () => pending.current?.(false), []);

  const dialog = question ? (
    <ConfirmDialog open title={question.title} confirmLabel={question.confirmLabel} cancelLabel={question.cancelLabel} tone={question.tone} onConfirm={() => answer(true)} onClose={() => answer(false)}>
      {question.body}
    </ConfirmDialog>
  ) : null;
  return [confirm, dialog];
}
