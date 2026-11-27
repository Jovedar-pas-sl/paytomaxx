'use client';

import { useState, type FormEvent } from 'react';
import { Button, Input, Modal, Select } from '@nightpay/ui';
import { GRANTABLE_SCOPES, PARTNER_SCOPES, type PartnerView } from '@nightpay/contracts';
import { createSaPartner, updateSaPartner } from '@/lib/endpoints/superadmin';
import { SCOPE_LABELS } from '@/lib/partner-connections';
import {
  CHANNEL_LABELS,
  COLLECTION_TEXT,
  DATA_ROLE_LABELS,
  EMPTY_PARTNER_FORM,
  partnerChanges,
  partnerFormOf,
  partnerPayload,
  updateNeedsTotp,
  type PartnerBody,
  type PartnerChanges,
  type PartnerForm,
} from '@/lib/superadmin/partner-forms';
import { StepUpDialog } from './StepUpDialog';
import { CheckRow, ErrorLine, Help, StickyActions } from './ui';

type Pending = { kind: 'create'; body: PartnerBody } | { kind: 'update'; changes: PartnerChanges };

/**
 * Alta o ficha de un socio: quién es (razón social y CIF), su techo de
 * permisos, las IP de sus servidores, el KYB y el contrato de datos. Sin KYB
 * ni contrato se puede dar de alta, pero ningún local podrá conectarlo.
 * «Quién cobra: el local», fijo hasta el PR 9.
 */
export function PartnerFormDialog({
  partner,
  onClose,
  onSaved,
}: {
  /** null: alta. */
  partner: PartnerView | null;
  onClose: () => void;
  onSaved: (saved: PartnerView) => void;
}) {
  const [form, setForm] = useState<PartnerForm>(() => (partner ? partnerFormOf(partner) : EMPTY_PARTNER_FORM));
  const [pending, setPending] = useState<Pending | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function change(patch: Partial<PartnerForm>): void {
    setForm((f) => ({ ...f, ...patch }));
    setError(null);
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    const payload = partnerPayload(form);
    if (!payload.ok) return setError(payload.error);
    if (!partner) return setPending({ kind: 'create', body: payload.value });
    const changes = partnerChanges(partner, payload.value);
    if (Object.keys(changes).length === 0) return setError('No has cambiado nada.');
    if (updateNeedsTotp(changes)) return setPending({ kind: 'update', changes });
    setSubmitting(true);
    try {
      onSaved(await updateSaPartner(partner.id, changes));
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  if (pending) {
    const name = pending.kind === 'create' ? pending.body.name : partner?.name ?? '';
    return (
      <StepUpDialog
        title={pending.kind === 'create' ? 'Nuevo socio' : `Cambiar ${name}`}
        action={pending.kind === 'create' ? 'partner.create' : 'partner.updateSensitive'}
        summary={
          pending.kind === 'create'
            ? `Vas a dar de alta a ${name} como socio de la API.`
            : `Vas a cambiar ${name}: ${Object.keys(pending.changes).length} campo(s), entre ellos permisos, IP, KYB o el contrato de datos.`
        }
        submitLabel={pending.kind === 'create' ? 'Dar de alta' : 'Guardar'}
        onSubmit={async ({ totpCode }) => {
          const saved =
            pending.kind === 'create'
              ? await createSaPartner(pending.body, totpCode)
              : await updateSaPartner(partner!.id, pending.changes, totpCode);
          onSaved(saved);
        }}
        onClose={() => setPending(null)}
      />
    );
  }

  const scopes = new Set(form.allowedScopes);
  return (
    <Modal open onClose={submitting ? () => undefined : onClose} title={partner ? `Ficha de ${partner.name}` : 'Nuevo socio'} width="42rem">
      <form className="np-sa-form np-ptn-form" onSubmit={(e) => void handleSubmit(e)} noValidate>
        <Input label="Nombre (lo ve el local, 2–30)" value={form.name} onChange={(e) => change({ name: e.target.value })} maxLength={60} required />
        <Input label="Razón social" value={form.legalName} onChange={(e) => change({ legalName: e.target.value })} maxLength={200} required />
        <Input label="NIF / CIF" value={form.taxId} onChange={(e) => change({ taxId: e.target.value })} maxLength={30} required />
        <Input
          label="Correo de contacto (ahí llega el enlace de la clave)"
          type="email"
          value={form.contactEmail}
          onChange={(e) => change({ contactEmail: e.target.value })}
          maxLength={254}
          required
        />
        <Select label="Canal" value={form.channel} onChange={(e) => change({ channel: e.target.value as PartnerForm['channel'] })}>
          {(Object.keys(CHANNEL_LABELS) as Array<PartnerForm['channel']>).map((c) => (
            <option key={c} value={c}>
              {CHANNEL_LABELS[c]}
            </option>
          ))}
        </Select>
        <Help>{COLLECTION_TEXT}.</Help>

        <fieldset className="np-ptn-fieldset">
          <legend className="np-ptn-label">Techo de permisos</legend>
          {PARTNER_SCOPES.map((s) => (
            <CheckRow
              key={s}
              checked={scopes.has(s)}
              onChange={(on) => change({ allowedScopes: PARTNER_SCOPES.filter((x) => (x === s ? on : scopes.has(x))) })}
              label={SCOPE_LABELS[s]}
              help={(GRANTABLE_SCOPES as readonly string[]).includes(s) ? undefined : 'Aún no lo puede dar ningún local.'}
            />
          ))}
        </fieldset>

        <label className="np-ptn-fieldset">
          <span className="np-ptn-label">IP de sus servidores (una por línea, 20 como mucho)</span>
          <textarea
            className="np-ptn-ipbox"
            value={form.egressIps}
            onChange={(e) => change({ egressIps: e.target.value })}
            rows={4}
            spellCheck={false}
            autoComplete="off"
          />
          <Help>Direcciones públicas. Un rango, de /24 (IPv4) o /48 (IPv6) como mucho y con su motivo.</Help>
        </label>
        <Input
          label="Motivo del rango (si hay alguno)"
          value={form.egressRangeReason}
          onChange={(e) => change({ egressRangeReason: e.target.value })}
          maxLength={500}
        />

        <Input type="date" label="KYB revisado el" value={form.kybCheckedAt} onChange={(e) => change({ kybCheckedAt: e.target.value })} />
        <Input label="Notas del KYB" value={form.kybNotes} onChange={(e) => change({ kybNotes: e.target.value })} maxLength={2000} />
        <Select
          label="Su papel con los datos"
          value={form.dataRole}
          onChange={(e) => change({ dataRole: e.target.value as PartnerForm['dataRole'] })}
        >
          <option value="">Sin decidir</option>
          {(Object.keys(DATA_ROLE_LABELS) as Array<keyof typeof DATA_ROLE_LABELS>).map((r) => (
            <option key={r} value={r}>
              {DATA_ROLE_LABELS[r]}
            </option>
          ))}
        </Select>
        <Input type="date" label="Contrato de datos firmado el" value={form.dpaSignedAt} onChange={(e) => change({ dpaSignedAt: e.target.value })} />
        <Input label="Versión del contrato de datos" value={form.dpaVersion} onChange={(e) => change({ dpaVersion: e.target.value })} maxLength={60} />
        <Input
          label="País donde guarda los datos (ES, PT…)"
          value={form.dataCountry}
          onChange={(e) => change({ dataCountry: e.target.value })}
          maxLength={2}
        />
        <Input
          label="Mecanismo de transferencia (fuera del EEE)"
          value={form.transferMechanism}
          onChange={(e) => change({ transferMechanism: e.target.value })}
          maxLength={500}
        />
        <Input label="Notas" value={form.notes} onChange={(e) => change({ notes: e.target.value })} maxLength={2000} />

        {error ? <ErrorLine>{error}</ErrorLine> : null}
        <StickyActions>
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button type="submit" loading={submitting}>
            {partner ? 'Guardar' : 'Dar de alta'}
          </Button>
        </StickyActions>
      </form>
    </Modal>
  );
}
