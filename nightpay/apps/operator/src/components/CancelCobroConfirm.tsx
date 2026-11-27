'use client';

import { Button, Sheet } from '@nightpay/ui';
import { CANCEL_AT_BANK_TEXT, CANCEL_CONFIRM_TITLE } from '@/lib/cobro-state';

/**
 * «¿Cancelar este cobro?»: «Cancelar cobro» siempre pide confirmar (decisión
 * del dueño). Con el cliente en su banco, además, que el pago puede entrar igual
 * (queda en Incidencias para devolverlo o darlo por bueno).
 */
export function CancelCobroConfirm({
  open,
  atBank,
  busy,
  detail,
  onConfirm,
  onClose,
}: {
  open: boolean;
  /** El cliente puede estar pagando en la página de su banco. */
  atBank: boolean;
  busy: boolean;
  /** Qué cobro (p. ej. «C-0012 · 12 € · de Lucía»), si no se ve detrás. */
  detail?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={CANCEL_CONFIRM_TITLE}
      footer={
        <div className="np-pregunta-pie">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Volver
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={busy} disabled={busy} loadingLabel="Cancelando">
            Cancelar cobro
          </Button>
        </div>
      }
    >
      <div style={{ display: 'grid', gap: '0.75rem' }}>
        {detail ? <p style={{ margin: 0, fontSize: 'var(--np-fs-16)', fontWeight: 600 }}>{detail}</p> : null}
        {atBank ? (
          <p role="note" style={{ margin: 0, fontSize: 'var(--np-fs-16)', lineHeight: 1.45, color: 'var(--np-warning)' }}>
            {CANCEL_AT_BANK_TEXT}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
