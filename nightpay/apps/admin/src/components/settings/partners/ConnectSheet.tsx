'use client';

import { useId, useState, type FormEvent } from 'react';
import { Button, Checkbox, FormError, Select, Sheet } from '@nightpay/ui';
import { stepUpActions, type PartnerKeyIssued, type PartnerOptionView } from '@nightpay/contracts';
import { createPartnerConnection } from '@/lib/endpoints/partner-connections';
import {
  MAX_CONNECTION_IPS,
  SCOPE_LABELS,
  createPayload,
  deliveryChoices,
  expiryBounds,
  expiryRequired,
  splitPartnerIps,
  type ConnectForm,
} from '@/lib/partner-connections';
import { RadioChoices } from './Choices';
import { ExpiryField } from './ExpiryField';
import { useSecondFactor } from './SecondFactor';

function initialForm(partner: PartnerOptionView | null): ConnectForm {
  const pickable = partner ? splitPartnerIps(partner.egressIps).pickable : [];
  return {
    partnerId: partner?.id ?? '',
    scopes: partner ? [...partner.allowedScopes] : [],
    // Las que declaró, marcadas (si caben): son sus servidores, ya revisados por OxioPay.
    ips: pickable.length <= MAX_CONNECTION_IPS ? pickable : [],
    noExpiry: false,
    expiryDay: expiryBounds(new Date()).suggested,
    delivery: 'copy',
  };
}

/**
 * «Conectar una plataforma» (solo el dueño): cuál, qué puede hacer, desde qué
 * IP (solo entre las que declaró a OxioPay: aquí no se escribe ninguna),
 * hasta cuándo y cómo le llega la clave. Con su 2FA (o su llave).
 */
export function ConnectSheet({
  partners,
  emailEnabled,
  onClose,
  onIssued,
}: {
  /** Las listas para conectar y aún sin conexión en este local. */
  partners: PartnerOptionView[];
  emailEnabled: boolean;
  onClose: () => void;
  onIssued: (issued: PartnerKeyIssued) => void;
}) {
  const formId = useId();
  const [form, setForm] = useState<ConnectForm>(() => initialForm(partners.length === 1 ? partners[0]! : null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const partner = partners.find((p) => p.id === form.partnerId) ?? null;
  const second = useSecondFactor(partner ? stepUpActions.partner('create', partner.id) : null, true, 'Ahora pulsa «Conectar».');
  const { pickable, ranges } = splitPartnerIps(partner?.egressIps ?? []);

  function change(patch: Partial<ConnectForm>): void {
    setForm((f) => ({ ...f, ...patch }));
    setError(null);
  }

  function toggle<T>(list: T[], item: T, on: boolean): T[] {
    return on ? [...list.filter((x) => x !== item), item] : list.filter((x) => x !== item);
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const payload = createPayload(form, partner, emailEnabled, new Date());
    if (!payload.ok) return setError(payload.error);
    if (!second.ready) return setError('Falta tu código de verificación (2FA) o confirmar con tu llave.');
    setBusy(true);
    setError(null);
    try {
      const issued = await createPartnerConnection(payload.value, second.factor);
      second.spent();
      onIssued(issued);
    } catch (err) {
      setError(second.failed(err));
    } finally {
      setBusy(false);
    }
  }

  const loadPicked = form.scopes.includes('wallet:load');
  return (
    <Sheet
      open
      title="Conectar una plataforma"
      onClose={busy ? () => undefined : onClose}
      full
      width="36rem"
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" form={formId} loading={busy}>
            Conectar
          </Button>
        </>
      }
    >
      <form id={formId} className="np-ptn-form" onSubmit={(e) => void submit(e)} noValidate>
        <Select
          label="Plataforma"
          value={form.partnerId}
          onChange={(e) => setForm(initialForm(partners.find((p) => p.id === e.target.value) ?? null))}
          disabled={busy}
          required
        >
          {partners.length !== 1 ? <option value="">Elige una</option> : null}
          {partners.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>

        {partner ? (
          <>
            <fieldset className="np-ptn-fieldset">
              <legend className="np-ptn-label">Qué puede hacer</legend>
              {partner.allowedScopes.map((s) => (
                <Checkbox
                  key={s}
                  label={SCOPE_LABELS[s]}
                  checked={form.scopes.includes(s)}
                  onChange={(on) => {
                    const scopes = toggle(form.scopes, s, on);
                    change({ scopes, noExpiry: expiryRequired(scopes) ? false : form.noExpiry });
                  }}
                  disabled={busy}
                />
              ))}
            </fieldset>

            <fieldset className="np-ptn-fieldset">
              <legend className="np-ptn-label">Desde qué IP</legend>
              <p className="np-ptn-help">
                Solo las de sus servidores que declaró a OxioPay. Desde cualquier otra, la clave no entra.
              </p>
              {pickable.map((ip) => (
                <Checkbox
                  key={ip}
                  label={<span className="np-ptn-mono">{ip}</span>}
                  checked={form.ips.includes(ip)}
                  onChange={(on) => change({ ips: toggle(form.ips, ip, on) })}
                  disabled={busy}
                />
              ))}
              {pickable.length === 0 ? <p className="np-ptn-help">No declaró direcciones sueltas.</p> : null}
              {ranges.length > 0 ? (
                <p className="np-ptn-help">
                  También declaró {ranges.length === 1 ? 'el rango' : 'los rangos'} <span className="np-ptn-mono">{ranges.join(', ')}</span>: una
                  clave lleva direcciones sueltas, así que pide a OxioPay que apunte las que usa.
                </p>
              ) : null}
              {loadPicked && form.ips.length === 0 ? (
                <p className="np-ptn-help">Para cargar saldo hacen falta las IP de sus servidores.</p>
              ) : null}
            </fieldset>

            <ExpiryField
              scopes={form.scopes}
              day={form.expiryDay}
              noExpiry={form.noExpiry}
              onDay={(expiryDay) => change({ expiryDay })}
              onNoExpiry={(noExpiry) => change({ noExpiry })}
              disabled={busy}
            />

            <RadioChoices
              legend="Cómo le llega la clave"
              options={deliveryChoices(emailEnabled, partner.contactEmail)}
              value={form.delivery}
              onChange={(delivery) => change({ delivery })}
              disabled={busy}
            />

            {second.field}
          </>
        ) : null}

        {error ? <FormError>{error}</FormError> : null}
      </form>
    </Sheet>
  );
}
