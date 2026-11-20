'use client';

import { useState, type FormEvent } from 'react';
import type { PartySettings, UpdatePartySettingsDto } from '@nightpay/contracts';
import { Input } from '@nightpay/ui';
import { totpRetryState } from '@/lib/api-errors';
import { fetchPartySettings, updatePartySettings } from '@/lib/endpoints/party';
import { OTP_LENGTH } from '@/lib/otp';
import { hasPartySettingsChange, partySettingsChange, partySettingsFormFrom, type PartySettingsForm } from '@/lib/party-settings';
import { useVenueTimezone } from '@/lib/venue-context';
import { OtpInput } from '../OtpInput';
import { LoadState, SaveRow, SettingsCard, Switch, useSavedFlash, useSettingsLoad } from '../settings/SettingsBits';

/**
 * OxioParty · Ajustes → La fiesta (maqueta Alta, «1 · Qué es» y «4 · Lo que
 * sobra»): cuándo empieza y acaba (con el fin ya pasado no hay cobros ni
 * recargas nuevos), hasta qué día se puede pedir la devolución de lo que
 * sobra, si se puede donar y desde cuánto efectivo en una caja sale el aviso.
 * La ve el encargado; solo el dueño la cambia (con su 2FA si la tiene).
 */
export function PartySettingsSection({ isOwner }: { isOwner: boolean }) {
  const { data, setData, error, retry } = useSettingsLoad(fetchPartySettings);
  if (!data) return <LoadState error={error} retry={retry} what="los ajustes de la fiesta" />;
  return <PartySettingsView settings={data} onSaved={setData} isOwner={isOwner} />;
}

export function PartySettingsView({
  settings,
  onSaved,
  isOwner,
}: {
  settings: PartySettings;
  onSaved: (s: PartySettings) => void;
  isOwner: boolean;
}) {
  const timeZone = useVenueTimezone();
  const [form, setForm] = useState<PartySettingsForm | null>(null);
  const current = form ?? partySettingsFormFrom(settings, timeZone);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, flashSaved] = useSavedFlash();
  const [pending, setPending] = useState<UpdatePartySettingsDto | null>(null);
  const [code, setCode] = useState('');
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const readOnly = !isOwner;

  function update(patch: Partial<PartySettingsForm>): void {
    setForm({ ...current, ...patch });
    setPending(null);
    setError(null);
  }

  async function send(change: UpdatePartySettingsDto, totpCode?: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const updated = await updatePartySettings(totpCode ? { ...change, totpCode } : change);
      onSaved(updated);
      setForm(partySettingsFormFrom(updated, timeZone));
      setPending(null);
      setCode('');
      flashSaved();
    } catch (err) {
      const retry = totpRetryState(err, Date.now());
      setLockedUntil(retry.lockedUntil);
      setCode('');
      if (retry.askCode) setPending(change);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    if (busy || readOnly) return;
    if (pending) {
      if (code.length !== OTP_LENGTH) return setError('Pon los 6 números de tu app de verificación.');
      void send(pending, code);
      return;
    }
    const plan = partySettingsChange(current, settings, timeZone);
    if (!plan.ok) return setError(plan.problem);
    if (!hasPartySettingsChange(plan.change)) return setError('No has cambiado nada.');
    void send(plan.change);
  }

  const status = settings.eventEnded
    ? 'La fiesta ya ha terminado: no se pueden hacer cobros ni recargas nuevos. Las consultas, el cierre y las devoluciones siguen.'
    : 'Al pasar la hora del fin, se cierra sola: ya no se cobra ni se recarga.';
  const endHint = settings.eventEnded
    ? 'Ya terminó: el fin no se puede quitar ni retrasar, para que el cierre y el % de cada caseta no cambien. Lo demás sí se puede cambiar.'
    : 'Vacío: no se cierra sola. Cuando termine, ya no se podrá quitar ni retrasar.';

  return (
    <form onSubmit={onSubmit} className="np-set-stack" noValidate>
      <SettingsCard title="Cuándo es" hint={`${status} Las horas, en la del local.`}>
        <div className="np-party-form">
          <Input
            label="Empieza"
            type="datetime-local"
            value={current.startsAt}
            onChange={(e) => update({ startsAt: e.target.value })}
            disabled={readOnly}
          />
          <Input
            label="Termina"
            type="datetime-local"
            value={current.endsAt}
            onChange={(e) => update({ endsAt: e.target.value })}
            disabled={readOnly}
            hint={endHint}
          />
        </div>
      </SettingsCard>

      <SettingsCard title="Lo que sobra en las pulseras" hint="Se devuelve siempre por internet, hasta el día que pongas.">
        <Input
          label="Último día para pedir la devolución"
          type="date"
          value={current.refundDeadline}
          onChange={(e) => update({ refundDeadline: e.target.value })}
          disabled={readOnly}
          hint="Vacío: sin fecha límite."
        />
        <Switch
          label="Dejar donarlo a la organización"
          hint="El asistente puede donar lo que le sobra en vez de pedir que se lo devuelvan."
          checked={current.allowDonation}
          onChange={(v) => update({ allowDonation: v })}
          disabled={readOnly}
        />
      </SettingsCard>

      <SettingsCard title="Aviso de efectivo" hint="En directo avisa cuando una taquilla acumula más efectivo de la cuenta.">
        <Input
          label="Avisar cuando una caja pase de (€)"
          inputMode="decimal"
          value={current.cashAlertEur}
          onChange={(e) => update({ cashAlertEur: e.target.value })}
          disabled={readOnly}
          hint="0 = sin aviso."
        />
      </SettingsCard>

      {pending ? (
        <OtpInput
          label="Código de tu app de verificación (2FA)"
          value={code}
          onChange={setCode}
          autoSubmit
          autoFocus
          lockedUntil={lockedUntil}
          disabled={busy}
          hint="Son reglas del dinero: al poner el sexto número se guarda."
        />
      ) : null}
      {readOnly ? (
        <p className="np-set-hint">Solo el dueño puede cambiar la fiesta.</p>
      ) : (
        <SaveRow busy={busy} saved={saved} error={error} label={pending ? 'Confirmar y guardar' : 'Guardar'} />
      )}
    </form>
  );
}
