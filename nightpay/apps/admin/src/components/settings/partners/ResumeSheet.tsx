'use client';

import { useId, useState, type FormEvent } from 'react';
import { Button, FormError, Sheet } from '@nightpay/ui';
import { stepUpActions, type PartnerConnectionView } from '@nightpay/contracts';
import { resumePartnerConnection } from '@/lib/endpoints/partner-connections';
import { useSecondFactor } from './SecondFactor';

/** «Reanudar» (solo el dueño, con su 2FA): quita la pausa (también la de las cargas por una IP ajena) y la despierta. */
export function ResumeSheet({
  connection,
  onClose,
  onDone,
}: {
  connection: PartnerConnectionView;
  onClose: () => void;
  onDone: (next: PartnerConnectionView) => void;
}) {
  const formId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const second = useSecondFactor(stepUpActions.partner('resume', connection.id), true, 'Ahora pulsa «Reanudar».');
  const foreign = connection.pausedBy === 'foreign_ip';

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    if (!second.ready) return setError('Falta tu código de verificación (2FA) o confirmar con tu llave.');
    setBusy(true);
    setError(null);
    try {
      const next = await resumePartnerConnection(connection.id, second.factor);
      second.spent();
      onDone(next);
    } catch (err) {
      setError(second.failed(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      title={`Reanudar ${connection.partnerName}`}
      onClose={busy ? () => undefined : onClose}
      full
      width="32rem"
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            Reanudar
          </Button>
        </>
      }
    >
      <form id={formId} className="np-ptn-form" onSubmit={(e) => void submit(e)} noValidate>
        <p className="np-ptn-lead">
          {foreign
            ? 'Se pausó porque alguien usó la clave desde IP que no son suyas. Si no fue la plataforma, mejor cambia la clave en vez de reanudar.'
            : 'La clave vuelve a funcionar con sus permisos.'}
        </p>
        {second.field}
        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Sheet>
  );
}
