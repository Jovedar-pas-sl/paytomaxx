'use client';

import { useState } from 'react';
import { Button, Input } from '@nightpay/ui';
import type { UpdatePaymentMethodsDto, VenuePaymentMethods } from '@nightpay/contracts';
import { fetchPaymentMethods, updatePaymentMethods } from '@/lib/api';
import { parseTipEuros, parseTipPercents, tipEurosText, tipPercentsText } from '@/lib/settings-forms';
import { LoadState, SaveRow, SettingsCard, StatusLine, Switch, useSavedFlash, useSettingsLoad } from './SettingsBits';

type MethodKey = 'card' | 'wallet' | 'nfc' | 'pos' | 'cashTopUp';

const METHODS: ReadonlyArray<{ key: MethodKey; label: string; hint: string }> = [
  { key: 'card', label: 'QR con tarjeta, Apple Pay o Google Pay', hint: 'El cliente escanea y paga en la página del banco.' },
  { key: 'wallet', label: 'Pago con saldo', hint: 'Recargas y pagos con Face ID o con su código y PIN.' },
  { key: 'nfc', label: 'Ficha NFC', hint: 'Acercar la ficha del saldo al móvil (con PIN desde el tope de Ajustes → Noche).' },
  { key: 'pos', label: 'Datáfono', hint: 'Cobros con el PAX o el datáfono del bar.' },
  {
    key: 'cashTopUp',
    label: 'Recarga en efectivo',
    hint: 'Cargar el saldo en efectivo en recepción (hasta 999,99 €). Quién puede, en Permisos. Entra en la caja de la noche.',
  },
];

/** Las que cobran: al menos una encendida. La recarga en efectivo es aparte (solo recarga). */
const CHARGE_METHODS: readonly MethodKey[] = ['card', 'wallet', 'nfc', 'pos'];

/**
 * Ajustes → Formas de cobro (dueño): qué acepta el local. Lo apagado no sale
 * en las apps del personal (ni, sin datáfono, su pestaña en el panel) y el
 * API lo rechaza (409). También las propinas.
 */
export function PaymentMethodsPanel({ onSaved }: { onSaved?: (methods: VenuePaymentMethods) => void } = {}) {
  const { data, setData, error: loadError, retry } = useSettingsLoad(fetchPaymentMethods);
  const [tipEuros, setTipEuros] = useState<string | null>(null);
  const [tipPercents, setTipPercents] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, flashSaved] = useSavedFlash();

  if (!data) return <LoadState error={loadError} retry={retry} what="las formas de cobro" />;
  const methods = data;

  async function save(change: UpdatePaymentMethodsDto, what: string): Promise<void> {
    setBusy(what);
    setError(null);
    try {
      const next: VenuePaymentMethods = await updatePaymentMethods(change);
      setData(next);
      onSaved?.(next);
      if ('tipFlatCents' in change || 'tipPercents' in change) {
        setTipEuros(null);
        setTipPercents(null);
      }
      flashSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function toggle(key: MethodKey | 'tips', next: boolean): void {
    if (!next && CHARGE_METHODS.includes(key as MethodKey) && CHARGE_METHODS.every((m) => m === key || !methods[m])) {
      setError('Deja al menos una forma de cobro encendida.');
      return;
    }
    void save({ [key]: next }, key);
  }

  function saveTips(): void {
    const flat = parseTipEuros(tipEuros ?? tipEurosText(methods.tipFlatCents));
    const pct = parseTipPercents(tipPercents ?? tipPercentsText(methods.tipPercents));
    if (!flat) return setError('Propinas en euros: de 1 a 3 importes enteros entre 1 y 50 (p. ej. 2, 5).');
    if (!pct) return setError('Propinas en %: de 1 a 3 porcentajes entre 1 y 50 (p. ej. 10, 15).');
    void save({ tipFlatCents: flat, tipPercents: pct }, 'tipPresets');
  }

  return (
    <div className="np-set-stack">
      <SettingsCard title="Formas de cobro" hint="Lo que apagues deja de salir en las apps del personal.">
        {METHODS.map((m) => (
          <Switch
            key={m.key}
            label={m.label}
            hint={m.hint}
            checked={methods[m.key]}
            disabled={busy !== null}
            onChange={(v) => toggle(m.key, v)}
          />
        ))}
      </SettingsCard>

      <SettingsCard title="Propinas" hint="La propina la elige el cliente al pagar (con tarjeta, con su saldo o con su PIN), sin nada marcado: estas son las que se le sugieren. El personal ya no la añade al cobrar.">
        <Switch
          label="Aceptar propinas"
          checked={methods.tips}
          disabled={busy !== null}
          onChange={(v) => toggle('tips', v)}
        />
        {methods.tips ? (
          <div className="np-set-grid">
            <Input
              label="Sugeridas hasta 40 € (en €)"
              value={tipEuros ?? tipEurosText(methods.tipFlatCents)}
              onChange={(e) => setTipEuros(e.target.value)}
              hint="Separadas por comas."
            />
            <Input
              label="Sugeridas desde 40 € (en %)"
              value={tipPercents ?? tipPercentsText(methods.tipPercents)}
              onChange={(e) => setTipPercents(e.target.value)}
              hint="Separados por comas."
            />
          </div>
        ) : null}
        {methods.tips ? <Button variant="ghost" disabled={busy !== null} onClick={() => setTipEuros('5, 10')}>Usar propinas de 5 € y 10 €</Button> : null}
        {methods.tips && (tipEuros !== null || tipPercents !== null) ? (
          <SaveRow onSave={saveTips} busy={busy === 'tipPresets'} saved={false} error={null} label="Guardar propinas" />
        ) : null}
      </SettingsCard>

      <StatusLine saved={saved} error={error} />
    </div>
  );
}
