'use client';

import { useState } from 'react';
import { Button, Input } from '@nightpay/ui';
import { TELEGRAM_CHAT_ID_RE, type UpdateAlertSettingsDto } from '@nightpay/contracts';
import { fetchAlertSettings, sendTelegramTest, updateAlertSettings } from '@/lib/api';
import { ALERT_KINDS, ALERT_KIND_LABELS, staffWatchChange, staffWatchFormFrom, type StaffWatchForm } from '@/lib/settings-forms';
import { LoadState, SaveRow, SettingsCard, StatusLine, Switch, useSavedFlash, useSettingsLoad } from './SettingsBits';

/**
 * Ajustes → Avisos de Telegram (dueño): qué avisos salen, a qué chat (el del
 * local o, sin él, el de OxioPay) y si llevan los nombres de las chicas (por
 * defecto no: Telegram es de fuera). «Probar» manda un mensaje al chat.
 */
export function AlertsPanel() {
  const { data, setData, error: loadError, retry } = useSettingsLoad(fetchAlertSettings);
  const [chat, setChat] = useState<string | null>(null);
  /** Avisos por persona mientras se teclean (null: lo guardado). */
  const [watch, setWatch] = useState<StaffWatchForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, flashSaved] = useSavedFlash();
  const [test, setTest] = useState<{ busy: boolean; text: string | null }>({ busy: false, text: null });

  if (!data) return <LoadState error={loadError} retry={retry} what="los avisos" />;
  const settings = data;

  async function save(change: UpdateAlertSettingsDto): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setData(await updateAlertSettings(change));
      if ('chatId' in change) setChat(null);
      if ('staffWatch' in change) setWatch(null);
      flashSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function saveChat(): void {
    const value = (chat ?? '').trim();
    if (value !== '' && !TELEGRAM_CHAT_ID_RE.test(value)) {
      setError('El chat es un número (los grupos empiezan por -100…) o @canal.');
      return;
    }
    void save({ chatId: value === '' ? null : value });
  }

  const watchForm = watch ?? staffWatchFormFrom(settings.staffWatch);
  function saveWatch(): void {
    const plan = staffWatchChange(watchForm, settings.staffWatch);
    if (!plan.ok) return setError(plan.problem);
    if (Object.keys(plan.change).length === 0) return setError('No has cambiado nada.');
    void save({ staffWatch: plan.change });
  }

  async function probar(): Promise<void> {
    setTest({ busy: true, text: null });
    try {
      const sent = await sendTelegramTest();
      setTest({ busy: false, text: sent ? 'Enviado: mira el chat.' : 'No llegó. Revisa el chat (y que el bot esté dentro).' });
    } catch (err) {
      setTest({ busy: false, text: (err as Error).message });
    }
  }

  const ready = settings.botConfigured && (settings.chatId !== null || settings.defaultChatConfigured);
  return (
    <div className="np-set-stack">
      {!settings.botConfigured ? (
        <p className="np-set-note">El servidor aún no tiene el bot de Telegram: los avisos no salen. Pídeselo a OxioPay.</p>
      ) : null}

      <SettingsCard
        title="Chat" tour="telegram-chat"
        hint={
          settings.chatId
            ? 'Los avisos de este local van a su propio chat.'
            : settings.defaultChatConfigured
              ? 'Sin chat propio, van al chat de OxioPay de todos tus locales.'
              : 'Pon el chat de este local para recibir los avisos.'
        }
      >
        <Input
          label="Chat de Telegram de este local"
          value={chat ?? settings.chatId ?? ''}
          placeholder="-1001234567890 o @canal"
          onChange={(e) => setChat(e.target.value)}
          hint="Vacío = el chat por defecto."
        />
        <div className="np-set-actions">
          {chat !== null ? <SaveRow onSave={saveChat} busy={busy} saved={false} error={null} label="Guardar chat" /> : null}
          <Button type="button" variant="ghost" onClick={() => void probar()} loading={test.busy} disabled={!ready || chat !== null}>
            Probar
          </Button>
          {test.text ? (
            <span role="status" className="np-set-row-hint">
              {test.text}
            </span>
          ) : null}
        </div>
      </SettingsCard>

      <SettingsCard title="Qué avisos salen" tour="telegram-avisos">
        {ALERT_KINDS.map((key) => (
          <Switch
            key={key}
            label={ALERT_KIND_LABELS[key]}
            checked={settings.kinds[key]}
            disabled={busy}
            onChange={(v) => void save({ kinds: { [key]: v } })}
          />
        ))}
      </SettingsCard>

      <SettingsCard
        title="Avisos por persona"
        tour="telegram-personas"
        hint="Salen en Avisos (y aquí, con «Cobros con problemas») cuando alguien del personal llega a uno de estos números en una noche. Tú no cuentas. 0 = no avisar. El personal no los ve."
      >
        <div className="np-set-grid">
          <Input
            label="Cobros cancelados"
            inputMode="numeric"
            value={watchForm.cancels}
            onChange={(e) => setWatch({ ...watchForm, cancels: e.target.value })}
          />
          <Input
            label="Cobrado con «Otro importe» (€)"
            inputMode="decimal"
            value={watchForm.freeAmountEur}
            onChange={(e) => setWatch({ ...watchForm, freeAmountEur: e.target.value })}
            hint="Lo tecleado, sin la carta."
          />
          <Input
            label="Saldos con el PIN fallado"
            inputMode="numeric"
            value={watchForm.pinFailSaldos}
            onChange={(e) => setWatch({ ...watchForm, pinFailSaldos: e.target.value })}
            hint="Saldos distintos, en el móvil de esa persona."
          />
          <Input
            label="Cobros seguidos al mismo saldo"
            inputMode="numeric"
            value={watchForm.sameSaldoCharges}
            onChange={(e) => setWatch({ ...watchForm, sameSaldoCharges: e.target.value })}
            hint="En 15 minutos."
          />
        </div>
        {watch !== null ? <SaveRow onSave={saveWatch} busy={busy} saved={false} error={null} label="Guardar avisos por persona" /> : null}
      </SettingsCard>

      <SettingsCard title="Privacidad" tour="telegram-privacidad">
        <Switch
          label="Poner el nombre de las compañeras"
          hint="Telegram es de fuera: por defecto los avisos no llevan nombres."
          checked={settings.includeNames}
          disabled={busy}
          onChange={(v) => void save({ includeNames: v })}
        />
      </SettingsCard>

      <StatusLine saved={saved} error={error} />
    </div>
  );
}
