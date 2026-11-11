'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Input, Select } from '@nightpay/ui';
import { invitationShareLabel, isZeroShare, type InvitationRules, type InvitationShare } from '@nightpay/contracts';
import { fetchInvitationRules, updateInvitationRules } from '@/lib/api';
import {
  REFERENCE_SPLIT,
  invitationExample,
  shareFromDraft,
  shareToDraft,
  showCamareroShare,
  type ShareDraft,
} from '@/lib/invitation-form';
import { LoadState, SaveRow, SettingsCard, useSavedFlash, useSettingsLoad } from './SettingsBits';

const EXAMPLE_PRICE_CENTS = 20_00;

/**
 * Ajustes → Secciones → Invitaciones (dueño): de cada «Copa con invitación»,
 * qué parte es de la chica invitada (% o € por copa); el resto, del local.
 * De fábrica, la mitad para ella. El camarero que la cobra consta como quien
 * la cobró, sin parte propia: su parte va aparte y cerrada (abierta solo si
 * el local le da algo, porque lo eligió el dueño).
 */
export function InvitationRulesCard() {
  const { data, setData, error: loadError, retry } = useSettingsLoad(fetchInvitationRules);
  const [chica, setChica] = useState<ShareDraft>({ kind: 'PERCENT', value: '' });
  const [camarero, setCamarero] = useState<ShareDraft>({ kind: 'PERCENT', value: '' });
  const [camareroOpen, setCamareroOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, flashSaved] = useSavedFlash();

  useEffect(() => {
    if (!data) return;
    setChica(shareToDraft(data.chica));
    setCamarero(shareToDraft(data.camarero));
    setCamareroOpen(showCamareroShare(shareToDraft(data.camarero)));
  }, [data]);

  if (!data) return <LoadState error={loadError} retry={retry} what="las invitaciones" />;

  const a = shareFromDraft(chica, 'la chica');
  const b = shareFromDraft(camarero, 'el camarero');
  const preview: InvitationRules | null = a.ok && b.ok ? { chica: a.share, camarero: b.share } : null;

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!a.ok) return setError(a.problem);
    if (!b.ok) {
      setCamareroOpen(true);
      return setError(b.problem);
    }
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
      title="Invitaciones" tour="secciones-invitaciones"
      hint="«Copa con invitación»: el cliente invita a una chica a una copa y quien la cobra escanea su QR («Mi QR» en su app). La chica se lleva su parte y el local, el resto."
    >
      <form onSubmit={(e) => void save(e)} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <ShareRow label="Para la chica invitada" draft={chica} onChange={setChica} disabled={busy} />
        <p style={hint}>{preview ? invitationExample(preview, EXAMPLE_PRICE_CENTS) : '—'}</p>
        <details className="np-set-more" open={camareroOpen} onToggle={(e) => setCamareroOpen(e.currentTarget.open)}>
          <summary>Parte del camarero que la cobra: {b.ok ? camareroText(b.share) : '—'}</summary>
          <div className="np-set-more-body">
            <p style={hint}>
              Lo normal es nada: el camarero consta como quien la cobró (sus cobros y su historial) y el local se queda lo que
              no es de la chica.
            </p>
            <ShareRow label="Para el camarero que la cobra" draft={camarero} onChange={setCamarero} disabled={busy} />
          </div>
        </details>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setChica(REFERENCE_SPLIT.chica);
            setCamarero(REFERENCE_SPLIT.camarero);
          }}
        >
          Reparto de referencia: la mitad para la chica
        </Button>
        <SaveRow busy={busy} saved={saved} error={error} />
      </form>
    </SettingsCard>
  );
}

/** «nada (lo normal)», «50 %» o «3,00 € por copa». */
function camareroText(s: InvitationShare): string {
  return isZeroShare(s) ? 'nada (lo normal)' : invitationShareLabel(s);
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
