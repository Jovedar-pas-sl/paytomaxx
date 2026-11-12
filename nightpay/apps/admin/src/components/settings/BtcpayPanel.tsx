'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Input, Select } from '@nightpay/ui';
import {
  BTCPAY_PURPOSES,
  BTCPAY_PURPOSE_LABELS,
  type BtcpayPurpose,
  type BtcpaySettingsView,
  type BtcpayTestResult,
} from '@nightpay/contracts';
import { fetchBtcpaySettings, saveBtcpaySettings, testBtcpaySettings, updateBtcpayMode } from '@/lib/api';
import { totpRetryState } from '@/lib/api-errors';
import { OTP_LENGTH } from '@/lib/otp';
import { OtpInput } from '../OtpInput';
import { SaveRow, SettingsCard, Switch, useSavedFlash } from './SettingsBits';

/**
 * Ajustes → Formas de cobro → «Bitcoin (BTCPay)» (solo el dueño). Cada local
 * conecta SU BTCPay: dirección, id de tienda y clave de API. «Probar conexión»
 * mira el servidor, los permisos de la clave (avisa de los que faltan y de los
 * que sobran) y la tienda. Guardar o cambiar los datos pide la 2FA, vuelve a
 * probar y registra el aviso en BTCPay. La clave no vuelve nunca a esta pantalla:
 * solo se ve cómo termina. Si el servidor no tiene el bitcoin encendido
 * (BTCPAY_ENABLED), la sección no sale.
 */
export function BtcpayPanel() {
  const [view, setView] = useState<BtcpaySettingsView | null | undefined>(undefined);
  const [form, setForm] = useState({ baseUrl: '', storeId: '', apiKey: '', purpose: 'BOTH' as BtcpayPurpose, enabled: false });
  const [code, setCode] = useState('');
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | 'mode' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<BtcpayTestResult | null>(null);
  const [saved, flashSaved] = useSavedFlash();

  useEffect(() => {
    let cancelled = false;
    fetchBtcpaySettings().then(
      (v) => {
        if (cancelled) return;
        setView(v);
        if (v) setForm({ baseUrl: v.baseUrl ?? '', storeId: v.storeId ?? '', apiKey: '', purpose: v.purpose, enabled: v.enabled });
      },
      () => !cancelled && setView(null),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (!view?.available) return null;
  const current = view;
  const keyNeeded = !current.configured || form.baseUrl.trim() !== (current.baseUrl ?? '') || form.storeId.trim() !== (current.storeId ?? '');

  function change(patch: Partial<typeof form>): void {
    setForm({ ...form, ...patch });
    setError(null);
    setTest(null);
  }

  async function runTest(): Promise<void> {
    setBusy('test');
    setError(null);
    try {
      const typed = form.baseUrl.trim() !== '' || form.storeId.trim() !== '' || form.apiKey.trim() !== '';
      setTest(
        await testBtcpaySettings(
          typed ? { baseUrl: form.baseUrl.trim() || undefined, storeId: form.storeId.trim() || undefined, apiKey: form.apiKey.trim() || undefined } : {},
        ),
      );
    } catch (err) {
      setTest(null);
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    if (code.length !== OTP_LENGTH) return setError('Pon los 6 números de tu app de verificación.');
    if (keyNeeded && form.apiKey.trim() === '') return setError('Escribe la clave de API de tu BTCPay.');
    setBusy('save');
    setError(null);
    try {
      const next = await saveBtcpaySettings({
        baseUrl: form.baseUrl.trim(),
        storeId: form.storeId.trim(),
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        enabled: form.enabled,
        purpose: form.purpose,
        totpCode: code,
      });
      setView(next);
      setForm({ baseUrl: next.baseUrl ?? '', storeId: next.storeId ?? '', apiKey: '', purpose: next.purpose, enabled: next.enabled });
      setCode('');
      setTest(null);
      flashSaved();
    } catch (err) {
      setLockedUntil(totpRetryState(err, Date.now()).lockedUntil);
      setCode('');
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function toggleEnabled(next: boolean): Promise<void> {
    if (busy) return;
    if (code.length !== OTP_LENGTH) return setError('Pon primero los 6 números de tu app de verificación (abajo) para cambiar esto.');
    setBusy('mode');
    setError(null);
    try {
      const updated = await updateBtcpayMode({ enabled: next, purpose: form.purpose, totpCode: code });
      setView(updated);
      setForm({ ...form, enabled: updated.enabled, purpose: updated.purpose });
      setCode('');
      flashSaved();
    } catch (err) {
      setLockedUntil(totpRetryState(err, Date.now()).lockedUntil);
      setCode('');
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="np-set-stack" noValidate>
      <SettingsCard
        title="Bitcoin (BTCPay)"
        tour="formas-bitcoin"
        hint="El cliente puede pagar con bitcoin desde la página de pago. Va a tu BTCPay y a tu cartera: no pasa por el banco. Apagado de fábrica."
      >
        <Switch
          label="Aceptar pagos con bitcoin en este local"
          hint={current.configured ? undefined : 'Primero guarda los datos de tu BTCPay.'}
          checked={current.enabled}
          disabled={busy !== null || !current.configured}
          onChange={(v) => void toggleEnabled(v)}
        />
        <Input label="Dirección de tu BTCPay" placeholder="https://pay.tulocal.es" inputMode="url" autoComplete="off" value={form.baseUrl} onChange={(e) => change({ baseUrl: e.target.value })} hint="Solo el dominio, con https." />
        <div className="np-set-grid">
          <Input label="Id de la tienda" autoComplete="off" value={form.storeId} onChange={(e) => change({ storeId: e.target.value })} hint="En BTCPay: Ajustes de la tienda, General." />
          <Input
            label="Clave de API"
            type="password"
            autoComplete="off"
            value={form.apiKey}
            placeholder={current.apiKeyHint ? `Guardada (${current.apiKeyHint})` : ''}
            onChange={(e) => change({ apiKey: e.target.value })}
            hint={keyNeeded ? 'Créala en BTCPay con solo estos 3 permisos: crear facturas, ver facturas y gestionar avisos (webhooks) de esta tienda.' : 'Déjala vacía para mantener la guardada.'}
          />
        </div>
        <Select label="Para qué lo usa este local" value={form.purpose} onChange={(e) => change({ purpose: e.target.value as BtcpayPurpose })}>
          {BTCPAY_PURPOSES.map((p) => (
            <option key={p} value={p}>
              {BTCPAY_PURPOSE_LABELS[p]}
            </option>
          ))}
        </Select>

        {current.configured && current.lastCheckAt ? (
          <p className="np-set-hint" role="status">
            Última comprobación: {current.lastCheckOk ? 'bien' : 'con problemas'}
            {current.lastCheckMessage ? ` — ${current.lastCheckMessage}` : ''}
            {current.webhookRegistered ? ' · Aviso de pagos registrado en BTCPay.' : ''}
          </p>
        ) : null}

        <div>
          <Button type="button" variant="ghost" disabled={busy !== null} loading={busy === 'test'} onClick={() => void runTest()}>
            Probar conexión
          </Button>
        </div>
        {test ? (
          <ul className="np-set-list" aria-label="Resultado de la prueba">
            {test.steps.map((s) => (
              <li key={s.id}>
                {s.ok ? 'Bien' : 'Mal'}: {s.message}
              </li>
            ))}
            {test.missingPermissions.length > 0 ? <li>Faltan permisos: {test.missingPermissions.join(', ')}</li> : null}
            {test.extraPermissions.length > 0 ? <li>Sobran permisos: {test.extraPermissions.join(', ')}</li> : null}
          </ul>
        ) : null}

        <OtpInput label="Tu código 2FA (para guardar o cambiar esto)" value={code} onChange={setCode} lockedUntil={lockedUntil} disabled={busy !== null} />
        <SaveRow busy={busy === 'save'} saved={saved} error={error} label="Guardar y registrar el aviso" />
      </SettingsCard>
    </form>
  );
}
