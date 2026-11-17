'use client';

import { useState, type FormEvent } from 'react';
import { Input } from '@nightpay/ui';
import { DISPLAY_MESSAGE_MAX, type CustomerDisplayMessage } from '@nightpay/contracts';
import { fetchDisplayMessage, updateDisplayMessage } from '@/lib/api';
import { displayMessagePlan, lineLength, type DisplayMessageDraft } from '@/lib/display-message';
import { LoadState, SaveRow, SettingsCard, useSavedFlash, useSettingsLoad } from './SettingsBits';

const draftOf = (m: CustomerDisplayMessage): DisplayMessageDraft => ({ line1: m.line1 ?? '', line2: m.line2 ?? '' });

/**
 * Ajustes → Carta → «Pantalla del cliente» (dueño y encargado): el mensaje
 * que enseña la tablet de la barra entre cobros, bajo el nombre del local.
 * Una línea y otra opcional; la vista previa enseña lo que se va a guardar.
 */
export function DisplayMessageCard() {
  const { data, setData, error: loadError, retry } = useSettingsLoad(fetchDisplayMessage);
  const [draft, setDraft] = useState<DisplayMessageDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, flashSaved] = useSavedFlash();

  const title = 'Pantalla del cliente: mensaje';
  const hint =
    'Lo que ve el cliente en la tablet de la barra entre cobros, debajo del nombre del local: una promoción o una fiesta. Sale en la tablet en unos segundos.';
  if (!data) {
    return (
      <SettingsCard title={title} hint={hint}>
        <LoadState error={loadError} retry={retry} what="el mensaje de la pantalla" />
      </SettingsCard>
    );
  }
  const current = draft ?? draftOf(data);
  const plan = displayMessagePlan(current);
  // Con una línea demasiado larga, la vista previa enseña lo escrito (y el aviso dice por qué no se guarda).
  const preview = plan.ok ? plan.message : { line1: current.line1.trim() || null, line2: current.line2.trim() || null };

  function update(patch: Partial<DisplayMessageDraft>): void {
    setDraft({ ...current, ...patch });
    setError(null);
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    if (!plan.ok) return setError(plan.problem);
    setBusy(true);
    setError(null);
    try {
      const next = await updateDisplayMessage(plan.message);
      setData(next);
      setDraft(draftOf(next));
      flashSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const counter = (text: string) => `${lineLength(text)} de ${DISPLAY_MESSAGE_MAX} letras`;
  // La línea que no cabe, en rojo y con cuántas sobran.
  const tooLong = (text: string) => {
    const n = lineLength(text);
    return n > DISPLAY_MESSAGE_MAX ? `${counter(text)}: quita ${n - DISPLAY_MESSAGE_MAX}` : undefined;
  };
  return (
    <form onSubmit={(e) => void onSubmit(e)} noValidate>
      <SettingsCard title={title} hint={hint}>
        <Input
          label="Mensaje"
          value={current.line1}
          onChange={(e) => update({ line1: e.target.value })}
          placeholder="Ej.: 2x1 en copas hasta la 1:00"
          hint={counter(current.line1)}
          error={tooLong(current.line1)}
          autoComplete="off"
          enterKeyHint="next"
        />
        <Input
          label="Segunda línea (si quieres)"
          value={current.line2}
          onChange={(e) => update({ line2: e.target.value })}
          placeholder="Ej.: Sábado: fiesta blanca"
          hint={counter(current.line2)}
          error={tooLong(current.line2)}
          autoComplete="off"
          enterKeyHint="done"
        />
        <p className="np-set-hint">Así se ve en la tablet:</p>
        <DisplayMessagePreview venueName={data.venueName} message={preview} />
        <p className="np-set-hint">Para quitarlo, deja las dos líneas vacías y guarda.</p>
        <SaveRow busy={busy} saved={saved} error={error ?? (plan.ok ? null : plan.problem)} label="Guardar mensaje" />
      </SettingsCard>
    </form>
  );
}

/** La tablet en pequeño (siempre oscura, como en la barra): el nombre y el mensaje debajo. */
export function DisplayMessagePreview({ venueName, message }: { venueName: string; message: CustomerDisplayMessage }) {
  return (
    <div className="np-dm-preview" data-theme="dark" role="group" aria-label="Vista previa de la pantalla del cliente">
      <p className="np-dm-venue">{venueName}</p>
      {message.line1 ? (
        <div className="np-dm-msg">
          <p className="np-dm-main">{message.line1}</p>
          {message.line2 ? <p className="np-dm-sub">{message.line2}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
