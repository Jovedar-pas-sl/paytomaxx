'use client';

import { useId, useState, type FormEvent } from 'react';
import { Button, FormError, Input, Sheet } from '@nightpay/ui';
import { LOAD_CAPS, PASSKEY_REQUIRED_CODE, type PartnerConnectionLimits, type PartnerConnectionView } from '@nightpay/contracts';
import { ApiError, needsTotpCode } from '@/lib/api-errors';
import { fetchPartnerConnections, updatePartnerLimits } from '@/lib/endpoints/partner-connections';
import { formatEur } from '@/lib/money';
import {
  LIMITS_START_TEXT,
  LIMIT_FIELDS,
  limitsFormOf,
  limitsPayload,
  limitsStepUpAction,
  type LimitsForm,
} from '@/lib/partner-connections';
import { useSecondFactor } from './SecondFactor';

/** Los máximos de cada tope (LOAD_CAPS), para la pista de cada campo. */
const CAP_HINT: Readonly<Record<keyof LimitsForm, string>> = {
  perOperation: `Hasta ${formatEur(LOAD_CAPS.perOperation.max)}.`,
  walletDay: `Hasta ${formatEur(LOAD_CAPS.walletDay.max)}.`,
  night: `Hasta ${formatEur(LOAD_CAPS.night.max)}.`,
};

/**
 * «Topes» (solo el dueño): lo máximo que cargan los cajeros de la plataforma
 * por recarga, por cliente al día y por noche, en euros. Bajar no pide nada;
 * subir alguno pide la 2FA (la acción lleva los tres topes en céntimos). Si
 * otro los cambió mientras tanto (PARTNER_LIMITS_CHANGED), se vuelven a leer.
 */
export function LimitsSheet({
  connection,
  onClose,
  onDone,
}: {
  connection: PartnerConnectionView;
  onClose: () => void;
  onDone: (next: PartnerConnectionView) => void;
}) {
  const formId = useId();
  const [current, setCurrent] = useState<PartnerConnectionLimits>(connection.limits);
  const [form, setForm] = useState<LimitsForm>(() => limitsFormOf(connection.limits));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const payload = limitsPayload(form, current);
  const raises = payload.ok && payload.value.raises;
  const action = payload.ok ? limitsStepUpAction(connection.id, payload.value.body) : null;
  const second = useSecondFactor(action, raises, 'Ahora pulsa «Guardar».', 'Para subir los topes.');

  function change(patch: Partial<LimitsForm>): void {
    setForm((f) => ({ ...f, ...patch }));
    setError(null);
  }

  /** Otro cambió los topes mientras tanto: los de ahora, en el formulario. */
  async function reread(): Promise<void> {
    try {
      const overview = await fetchPartnerConnections();
      const fresh = overview.connections.find((c) => c.id === connection.id);
      if (fresh) {
        setCurrent(fresh.limits);
        setForm(limitsFormOf(fresh.limits));
      }
    } catch {
      // Sin leerlos, se queda el aviso del servidor: al volver a abrir «Topes» salen los de ahora.
    }
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    if (!payload.ok) return setError(payload.error);
    if (raises && !second.ready) return setError('Subir un tope pide tu código de verificación (2FA) o confirmar con tu llave.');
    setBusy(true);
    setError(null);
    try {
      const next = await updatePartnerLimits(connection.id, payload.value.body, raises ? second.factor : {});
      second.spent();
      onDone(next);
    } catch (err) {
      // Otro los cambió mientras tanto: o el API lo dice, o pide la 2FA para lo que aquí parecía bajar.
      const stale =
        (err instanceof ApiError && err.code === 'PARTNER_LIMITS_CHANGED') ||
        (!raises && (needsTotpCode(err) || (err instanceof ApiError && err.code === PASSKEY_REQUIRED_CODE)));
      if (stale) {
        second.spent();
        setError(err instanceof ApiError && err.code === 'PARTNER_LIMITS_CHANGED' ? err.message : 'Los topes han cambiado mientras tanto: vuelve a escribirlos.');
        await reread();
      } else {
        setError(raises ? second.failed(err) : err instanceof Error && err.message ? err.message : 'No se pudo guardar. Vuelve a probar.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      title={`Topes de ${connection.partnerName}`}
      onClose={busy ? () => undefined : onClose}
      full
      width="32rem"
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            Guardar
          </Button>
        </>
      }
    >
      <form id={formId} className="np-ptn-form" onSubmit={(e) => void submit(e)} noValidate>
        <p className="np-ptn-lead">Lo máximo que pueden cargar sus cajeros en el saldo de tus clientes.</p>
        <p className="np-ptn-help">{LIMITS_START_TEXT}</p>
        {LIMIT_FIELDS.map((f) => (
          <Input
            key={f.key}
            label={f.label}
            value={form[f.key]}
            onChange={(e) => change({ [f.key]: e.target.value })}
            inputMode="decimal"
            autoComplete="off"
            suffix="€"
            hint={CAP_HINT[f.key]}
            disabled={busy}
          />
        ))}
        {raises ? second.field : null}
        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Sheet>
  );
}
