'use client';

import { useState, type FormEvent } from 'react';
import { Input } from '@nightpay/ui';
import { fetchVenueSettings, updateVenueSettings, type VenueRulesInput, type VenueSettings } from '@/lib/api';
import { totpRetryState } from '@/lib/api-errors';
import { formatEur } from '@/lib/money';
import { OTP_LENGTH } from '@/lib/otp';
import {
  commissionFields,
  holdDaysText,
  platformCommissionHint,
  rulesChange,
  rulesFormFrom,
  serviceFeeRulesText,
  type RulesForm,
} from '@/lib/settings-forms';
import { useSections } from '@/lib/use-sections';
import { OtpInput } from '../OtpInput';
import { LoadState, SaveRow, SettingsCard, Switch, useSavedFlash, useSettingsLoad } from './SettingsBits';

/**
 * Ajustes → Reglas del local (dueño): tope por cobro de una chica,
 * comisiones por categoría, días de espera para pagarles, desde cuánto una
 * devolución pide aprobación y si los pagos a las chicas la piden. Son reglas
 * de dinero: con la 2FA activada, guardar pide el código. La comisión de
 * OxioPay solo se enseña (la cambia OxioPay).
 */
export function RulesPanel() {
  const { data: settings, setData, error: loadError, retry } = useSettingsLoad(fetchVenueSettings);
  // Cada comisión con el nombre de su sección en este local (Ajustes → Secciones).
  const { sections } = useSections();
  const fields = commissionFields(sections);
  const [form, setForm] = useState<RulesForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, flashSaved] = useSavedFlash();
  /** El cambio que espera el código 2FA. */
  const [pending, setPending] = useState<VenueRulesInput | null>(null);
  const [code, setCode] = useState('');
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);

  if (!settings) return <LoadState error={loadError} retry={retry} what="las reglas del local" />;
  const current = form ?? rulesFormFrom(settings);

  function update(patch: Partial<RulesForm>): void {
    setForm({ ...current, ...patch });
    setPending(null);
    setError(null);
  }

  async function send(change: VenueRulesInput, totpCode?: string): Promise<void> {
    if (!settings) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateVenueSettings(change, totpCode);
      const merged: VenueSettings = { ...settings, ...updated };
      setData(merged);
      setForm(rulesFormFrom(merged));
      setPending(null);
      setCode('');
      flashSaved();
    } catch (err) {
      const retryState = totpRetryState(err, Date.now());
      setLockedUntil(retryState.lockedUntil);
      setCode('');
      if (retryState.askCode) setPending(change);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    if (!settings || busy) return;
    if (pending) {
      if (code.length !== OTP_LENGTH) return setError('Pon los 6 números de tu app de verificación.');
      void send(pending, code);
      return;
    }
    const plan = rulesChange(current, settings, fields);
    if (!plan.ok) return setError(plan.problem);
    if (Object.keys(plan.change).length === 0) return setError('No has cambiado nada.');
    void send(plan.change);
  }

  const effectiveDays = settings.effectivePayoutHoldDays ?? 0;
  const serviceFee = serviceFeeRulesText(settings);
  return (
    <form onSubmit={onSubmit} className="np-set-stack" noValidate>
      <SettingsCard title="Comisión del servicio al cliente" tour="reglas-comision" hint={`${serviceFee.status} (la cambia OxioPay).`}>
        <ul className="np-set-list">
          {serviceFee.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </SettingsCard>

      <SettingsCard title="Cobros de las compañeras" tour="reglas-chicas" hint={platformCommissionHint(settings)}>
        <Input
          label="Tope por cobro con «Otro importe»"
          suffix="€"
          inputMode="decimal"
          value={current.maxCobroEur}
          onChange={(e) => update({ maxCobroEur: e.target.value })}
          hint={`Hoy: ${formatEur(settings.operatorMaxCobroCents)}. Vale para compañeras, camareros y encargados; tú no tienes tope. Los cobros de la carta no cuentan.`}
        />
        <div className="np-set-grid">
          {fields.map(({ key, label }) => (
            <Input
              key={key}
              label={`${label} (%)`}
              inputMode="decimal"
              value={current.commissions[key]}
              onChange={(e) => update({ commissions: { ...current.commissions, [key]: e.target.value } })}
            />
          ))}
        </div>
      </SettingsCard>

      <SettingsCard title="Pagos a las compañeras" tour="reglas-pagos" hint={holdDaysText(effectiveDays)}>
        <Input
          label="Días de espera para pagarles"
          inputMode="numeric"
          value={current.holdDays}
          placeholder={settings.payoutHoldDays === null || settings.payoutHoldDays === undefined ? String(effectiveDays) : ''}
          onChange={(e) => update({ holdDays: e.target.value })}
          hint="0 = se les paga al cerrar la noche. Vacío = lo de OxioPay."
        />
        <Switch
          label="Los pagos del encargado necesitan tu aprobación"
          hint="El encargado los pide y tú los apruebas con tu código."
          checked={current.payoutRequiresApproval}
          onChange={(v) => update({ payoutRequiresApproval: v })}
        />
      </SettingsCard>

      <SettingsCard title="Devoluciones" tour="reglas-devoluciones">
        <Input
          label="El encargado pide aprobación desde"
          suffix="€"
          inputMode="decimal"
          value={current.refundThresholdEur}
          onChange={(e) => update({ refundThresholdEur: e.target.value })}
          hint="Por debajo devuelve él; desde este importe te lo pide. 0 = siempre te lo pide."
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
          hint="Son reglas de dinero: al poner el sexto número se guarda."
        />
      ) : null}
      <SaveRow busy={busy} saved={saved} error={error} label={pending ? 'Confirmar y guardar' : 'Guardar'} />
    </form>
  );
}
