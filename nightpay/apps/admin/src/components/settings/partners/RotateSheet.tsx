'use client';

import { useId, useState, type FormEvent } from 'react';
import { Button, FormError, Sheet } from '@nightpay/ui';
import { stepUpActions, type PartnerConnectionView, type PartnerKeyIssued } from '@nightpay/contracts';
import { rotatePartnerKey } from '@/lib/endpoints/partner-connections';
import {
  OVERLAP_CHOICES,
  deliveryChoices,
  expiryBounds,
  rotatePayload,
  suggestedOverlap,
  type RotateForm,
} from '@/lib/partner-connections';
import { RadioChoices } from './Choices';
import { ExpiryField } from './ExpiryField';
import { useSecondFactor } from './SecondFactor';

const OVERLAP_HINTS: Readonly<Record<RotateForm['overlap'], string>> = {
  none: 'La de ahora deja de valer al momento. Si alguien la está usando sin permiso, así se corta.',
  '24h': 'La de ahora vale 24 horas más, para que la plataforma cambie la suya sin cortes.',
  '7d': 'La de ahora vale 7 días más.',
};

/**
 * «Cambiar clave» (solo el dueño, con su 2FA): una clave nueva, hasta cuándo
 * sigue valiendo la de ahora (con una IP ajena o la clave a la vista, «Nada»
 * marcado), su caducidad y cómo le llega. La pausa, si la hay, sigue.
 */
export function RotateSheet({
  connection,
  emailEnabled,
  maskedEmail,
  onClose,
  onIssued,
}: {
  connection: PartnerConnectionView;
  emailEnabled: boolean;
  /** El correo tapado de la plataforma (si está en la lista para conectar). */
  maskedEmail: string | null;
  onClose: () => void;
  onIssued: (issued: PartnerKeyIssued) => void;
}) {
  const formId = useId();
  const [form, setForm] = useState<RotateForm>(() => ({
    overlap: suggestedOverlap(connection),
    noExpiry: false,
    expiryDay: expiryBounds(new Date()).suggested,
    delivery: 'copy',
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const second = useSecondFactor(stepUpActions.partner('rotate', connection.id), true, `Ahora pulsa «Cambiar clave».`);

  function change(patch: Partial<RotateForm>): void {
    setForm((f) => ({ ...f, ...patch }));
    setError(null);
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const payload = rotatePayload(form, connection, emailEnabled, new Date());
    if (!payload.ok) return setError(payload.error);
    if (!second.ready) return setError('Falta tu código de verificación (2FA) o confirmar con tu llave.');
    setBusy(true);
    setError(null);
    try {
      const issued = await rotatePartnerKey(connection.id, payload.value, second.factor);
      second.spent();
      onIssued(issued);
    } catch (err) {
      setError(second.failed(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      title={`Cambiar la clave de ${connection.partnerName}`}
      onClose={busy ? () => undefined : onClose}
      full
      width="36rem"
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            Cambiar clave
          </Button>
        </>
      }
    >
      <form id={formId} className="np-ptn-form" onSubmit={(e) => void submit(e)} noValidate>
        <p className="np-ptn-lead">Sale una clave nueva. Los permisos y las IP no cambian.</p>
        <RadioChoices
          legend="Cuánto sigue valiendo la de ahora"
          options={OVERLAP_CHOICES.map((o) => ({ ...o, hint: OVERLAP_HINTS[o.value] }))}
          value={form.overlap}
          onChange={(overlap) => change({ overlap })}
          disabled={busy}
        />
        <ExpiryField
          scopes={connection.scopes}
          day={form.expiryDay}
          noExpiry={form.noExpiry}
          onDay={(expiryDay) => change({ expiryDay })}
          onNoExpiry={(noExpiry) => change({ noExpiry })}
          disabled={busy}
        />
        <RadioChoices
          legend="Cómo le llega la clave"
          options={deliveryChoices(emailEnabled, maskedEmail)}
          value={form.delivery}
          onChange={(delivery) => change({ delivery })}
          disabled={busy}
        />
        {second.field}
        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Sheet>
  );
}
