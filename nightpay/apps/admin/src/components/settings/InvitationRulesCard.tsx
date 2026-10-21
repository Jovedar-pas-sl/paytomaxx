'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Input, Select } from '@nightpay/ui';
import type { InvitationRules, InvitationShare } from '@nightpay/contracts';
import { fetchInvitationRules, updateInvitationRules } from '@/lib/api';
import { invitationExample, shareFromDraft, shareToDraft, type ShareDraft } from '@/lib/invitation-form';
import { LoadState, SaveRow, SettingsCard, useSavedFlash, useSettingsLoad } from './SettingsBits';

const EXAMPLE_PRICE_CENTS = 20_00;

/**
 * Ajustes → Secciones → Invitaciones (dueño): de cada «Invitar a una copa»,
 * qué parte es de la chica invitada y cuál del camarero que la cobra (% o €
 * por copa); el resto, del local. De fábrica, chica 50 % y camarero 0 %
 * (provisional: lo decide el dueño).
 */
export function InvitationRulesCard() {
  const { data, setData, error: loadError, retry } = useSettingsLoad(fetchInvitationRules);
  const [chica, setChica] = useState<ShareDraft>({ kind: 'PERCENT', value: '' });
  const [camarero, setCamarero] = useState<ShareDraft>({ kind: 'PERCENT', value: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, flashSaved] = useSavedFlash();

  useEffect(() => {
    if (!data) return;
    setChica(shareToDraft(data.chica));
    setCamarero(shareToDraft(data.camarero));
  }, [data]);

  if (!data) return <LoadState error={loadError} retry={retry} what="las invitaciones" />;

  const a = shareFromDraft(chica, 'la chica');
  const b = shareFromDraft(camarero, 'el camarero');
  const preview: InvitationRules | null = a.ok && b.ok ? { chica: a.share, camarero: b.share } : null;

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!a.ok) return setError(a.problem);
    if (!b.ok) return setError(b.problem);
    setBusy(true);
    setError(null);
    try {
      setData(await updateInvitationRules({ chica: a.share, camarero: b.share }));
      flashSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard
      title="Invitaciones"
      hint="«Invitar a una copa»: el cliente invita a una chica y el camarero escanea su QR. Así se reparte cada invitación; lo que quede es del local."
    >
      <form onSubmit={(e) => void save(e)} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <ShareRow label="Para la chica invitada" draft={chica} onChange={setChica} disabled={busy} />
        <ShareRow label="Para el camarero que la cobra" draft={camarero} onChange={setCamarero} disabled={busy} />
        <p style={hint}>{preview ? invitationExample(preview, EXAMPLE_PRICE_CENTS) : '—'}</p>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => {
          setChica({ kind: 'PERCENT', value: '50' }); setCamarero({ kind: 'PERCENT', value: '50' });
        }}>Usar reparto de referencia: 10 € chica y 10 € camarero en una copa de 20 €</Button>
        <SaveRow busy={busy} saved={saved} error={error} />
      </form>
    </SettingsCard>
  );
}

function ShareRow({
  label,
  draft,
  onChange,
  disabled,
}: {
  label: string;
  draft: ShareDraft;
  onChange: (d: ShareDraft) => void;
  disabled: boolean;
}) {
  return (
    <div style={row}>
      <Input
        label={label}
        value={draft.value}
        onChange={(e) => onChange({ ...draft, value: e.target.value })}
        inputMode="decimal"
        disabled={disabled}
      />
      <Select
        label="Cómo"
        value={draft.kind}
        onChange={(e) => onChange({ ...draft, kind: e.target.value as InvitationShare['kind'] })}
        disabled={disabled}
      >
        <option value="PERCENT">% del precio</option>
        <option value="FIXED">€ por copa</option>
      </Select>
    </div>
  );
}

const row: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', gap: '0.5rem 1rem' };
const hint: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '0.9375rem' };
