'use client';

import { useState, type FormEvent } from 'react';
import { Button, Input } from '@nightpay/ui';
import type { VenueNightSettings } from '@nightpay/contracts';
import { fetchNightSettings, updateNightSettings } from '@/lib/api';
import { nightChange, nightFormFrom, noPinSummary, type NightForm } from '@/lib/night-form';
import { LoadState, SaveRow, SettingsCard, Switch, useSavedFlash, useSettingsLoad } from './SettingsBits';

/**
 * Ajustes → Noche (dueño): el NFC sin PIN (hasta cuánto por cobro y el tope
 * de la noche), el teclado del PIN, la recepción y la vibración y el sonido
 * al cobrar. Todo con un valor de fábrica que funciona sin tocar nada.
 */
export function NightPanel() {
  const { data, setData, error: loadError, retry } = useSettingsLoad(fetchNightSettings);
  const [form, setForm] = useState<NightForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, flashSaved] = useSavedFlash();

  if (!data) return <LoadState error={loadError} retry={retry} what="los ajustes de la noche" />;
  const settings: VenueNightSettings = data;
  const current = form ?? nightFormFrom(settings);

  function update(patch: Partial<NightForm>): void {
    setForm({ ...current, ...patch });
    setError(null);
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const plan = nightChange(current, settings);
    if (!plan.ok) return setError(plan.problem);
    if (Object.keys(plan.change).length === 0) return setError('No has cambiado nada.');
    setBusy(true);
    setError(null);
    try {
      const next = await updateNightSettings(plan.change);
      setData(next);
      setForm(nightFormFrom(next));
      flashSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="np-set-stack" noValidate>
      <SettingsCard
        title="NFC sin PIN"
        hint="El cliente solo acerca su NFC (tarjeta, ficha o pulsera) y queda pagado. Por encima, o al pasar el tope de la noche, pone su PIN."
      >
        <div className="np-set-grid">
          <Input
            label="Sin PIN hasta (€ por cobro)"
            inputMode="decimal"
            value={current.noPinMaxEur}
            onChange={(e) => update({ noPinMaxEur: e.target.value })}
            hint="0 = siempre con PIN. Como mucho 50 €."
          />
          <Input
            label="Tope sin PIN por noche (€)"
            inputMode="decimal"
            value={current.noPinNightCapEur}
            onChange={(e) => update({ noPinNightCapEur: e.target.value })}
            hint="Al pasarlo pide el PIN una vez y vuelve a contar."
          />
        </div>
        <p className="np-set-note">
          {noPinSummary(settings)} Si el cliente pierde su NFC, lo más que se gasta sin PIN es el tope de la noche (de 08:00 a
          08:00), hasta que se bloquea.
        </p>
      </SettingsCard>

      <SettingsCard title="Teclado del PIN" hint="Lo que ve el cliente al poner su PIN en el móvil del personal o en el datáfono.">
        <Switch
          label="Desordenar las cifras"
          hint="Fijo (de fábrica) es más fácil a oscuras y el cliente lo tapa con la mano. Desordenado cambia las cifras de sitio cada vez."
          checked={current.pinKeypad === 'shuffled'}
          onChange={(v) => update({ pinKeypad: v ? 'shuffled' : 'fixed' })}
        />
      </SettingsCard>

      <SettingsCard title="Recepción" hint="Al recargar un saldo: los importes de un toque y el botón grande. A la salida: hasta cuánto devuelve sola.">
        <Input
          label="Importes rápidos (€)"
          inputMode="numeric"
          value={current.quickAmountsEur}
          onChange={(e) => update({ quickAmountsEur: e.target.value })}
          hint="Separados por comas, hasta 4 (p. ej. 20, 50, 100)."
        />
        <div className="np-set-row">
          <div className="np-set-row-text">
            <span className="np-set-row-label" id="np-night-default-method">
              Cobro por defecto
            </span>
            <span className="np-set-row-hint">El botón grande.</span>
          </div>
          <div role="group" aria-labelledby="np-night-default-method" style={choiceRow}>
            {(
              [
                ['cash', 'Efectivo'],
                ['card', 'Tarjeta'],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                type="button"
                variant={current.receptionDefaultMethod === value ? 'primary' : 'ghost'}
                aria-pressed={current.receptionDefaultMethod === value}
                onClick={() => update({ receptionDefaultMethod: value })}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
        <Input
          label="Salidas en efectivo por persona y noche (€)"
          inputMode="decimal"
          value={current.payoutNightCapEur}
          onChange={(e) => update({ payoutNightCapEur: e.target.value })}
          hint="Lo que cada persona de recepción devuelve en efectivo con el NFC y el PIN del cliente en una noche (de 08:00 a 08:00). Al pasarlo, cada salida la confirma el encargado con su 2FA y te llega un aviso. 0 = siempre el encargado."
        />
      </SettingsCard>

      <SettingsCard title="Al cobrar" hint="El aviso del resultado (pagado o no) en las apps del personal. Por si en algún local molestan.">
        <Switch
          label="Vibración"
          hint="Solo en Android (el iPhone no vibra desde la web)."
          checked={current.feedbackVibration}
          onChange={(v) => update({ feedbackVibration: v })}
        />
        <Switch label="Sonido" checked={current.feedbackSound} onChange={(v) => update({ feedbackSound: v })} />
      </SettingsCard>

      <SaveRow busy={busy} saved={saved} error={error} />
    </form>
  );
}

const choiceRow = { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' } as const;
