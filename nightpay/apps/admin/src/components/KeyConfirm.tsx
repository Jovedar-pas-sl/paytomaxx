'use client';

import { useState, type CSSProperties } from 'react';
import { unlockName, type StepUpProof } from '@nightpay/contracts';
import { Button } from '@nightpay/ui';
import { StepUpDialog } from './StepUpDialog';

/**
 * Para quien no tiene la 2FA y sí una llave de acceso: «Confirmar con Face
 * ID» (o huella) antes del botón de la acción. La confirmación vale para esa
 * acción, una vez y 2 minutos (otro importe pide confirmar otra vez).
 */
export function KeyConfirm({
  action,
  confirmed,
  onProof,
  reason,
  next,
}: {
  /** La acción (stepUpActions); null mientras falta algo (p. ej. el importe). */
  action: string | null;
  confirmed: boolean;
  onProof: (proof: StepUpProof) => void;
  reason: string;
  /** Lo que queda después de confirmar («Ahora pulsa «Devolver 120,00 €».»). */
  next: string;
}) {
  const unlock = unlockName(typeof navigator === 'undefined' ? null : navigator.userAgent);
  const [open, setOpen] = useState(false);
  if (confirmed) {
    return (
      <p role="status" style={note}>
        Confirmado con {unlock}. {next}
      </p>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
      <Button type="button" variant="ghost" onClick={() => setOpen(true)} disabled={!action}>
        Confirmar con {unlock}
      </Button>
      <p style={note}>No tienes la verificación en dos pasos: se confirma con tu llave de acceso, en este móvil.</p>
      <StepUpDialog open={open} onClose={() => setOpen(false)} action={action ?? undefined} onProof={onProof} reason={reason} />
    </div>
  );
}

const note: CSSProperties = { margin: 0, fontSize: '0.8125rem', color: 'var(--np-text-mute)' };
