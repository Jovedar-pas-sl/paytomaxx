'use client';

import { useId, useState, type FormEvent } from 'react';
import { Banner, Button, FormError, Input, Sheet } from '@nightpay/ui';
import { stepUpActions, type PartnerLoadAdminView } from '@nightpay/contracts';
import { voidPartnerLoad } from '@/lib/endpoints/partner-connections';
import { formatEur } from '@/lib/money';
import { VOID_REASON_MAX, deviceLabel, voidLoadWarning, voidReasonProblem } from '@/lib/partner-connections';
import { useSecondFactor } from './SecondFactor';

/**
 * «Anular carga» (dueño y encargado, con su 2FA): una carga de un cajero de
 * otra plataforma que no se cobró. El motivo, de 3 a 140 letras. Manda el
 * servidor: pasadas 36 h o con el saldo ya gastado contesta 409 y su texto
 * se enseña tal cual.
 */
export function VoidLoadSheet({
  connectionId,
  load,
  onClose,
  onDone,
}: {
  connectionId: string;
  load: PartnerLoadAdminView;
  onClose: () => void;
  onDone: (next: PartnerLoadAdminView) => void;
}) {
  const formId = useId();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const second = useSecondFactor(stepUpActions.partner('void', load.id), true, 'Ahora pulsa «Anular carga».', 'Para anular una carga.');

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const problem = voidReasonProblem(reason);
    if (problem) return setError(problem);
    if (!second.ready) return setError('Falta tu código de verificación (2FA) o confirmar con tu llave.');
    setBusy(true);
    setError(null);
    try {
      const next = await voidPartnerLoad(connectionId, load.id, reason.trim(), second.factor);
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
      title={`Anular la carga de ${formatEur(load.amountCents)}`}
      onClose={busy ? () => undefined : onClose}
      full
      width="32rem"
      footer={
        <>
          <Button type="button" variant="ghost" size="lg" onClick={onClose} disabled={busy}>
            Volver
          </Button>
          <Button type="submit" variant="danger" size="lg" form={formId} loading={busy}>
            Anular carga
          </Button>
        </>
      }
    >
      <form id={formId} className="np-ptn-form" onSubmit={(e) => void submit(e)} noValidate>
        <p className="np-ptn-lead">
          {formatEur(load.amountCents)} al saldo {load.codeHint} · {deviceLabel(load.device)}
        </p>
        <p className="np-ptn-help">{load.description}</p>
        <Banner tone="warning">{voidLoadWarning(load.amountCents)}</Banner>
        <Input
          label="Por qué se anula"
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setError(null);
          }}
          maxLength={140}
          hint={`De 3 a ${VOID_REASON_MAX} letras.`}
          disabled={busy}
        />
        {second.field}
        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Sheet>
  );
}
