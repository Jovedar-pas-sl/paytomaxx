'use client';

import { useState, type CSSProperties } from 'react';
import { Checkbox, Input } from '@nightpay/ui';
import { LEGACY_SECTION_META, TIPS_SECTION_META, type SectionCode, type VenueSection } from '@nightpay/contracts';
import { fetchSections, updateSections } from '@/lib/api';
import { useSections } from '@/lib/use-sections';
import { SectionChip } from '../fichas/SectionChip';
import { InvitationRulesCard } from './InvitationRulesCard';
import { PostRulesCard } from './PostRulesCard';
import { LoadState, SaveRow, SettingsCard, useSavedFlash, useSettingsLoad } from './SettingsBits';

/**
 * Ajustes → Secciones (dueño): cada cobro cae en su sección (Servicios,
 * Copas, Habitaciones, Comida, Entradas). Aquí se cambia su nombre, su color
 * (el mismo en las apps, el panel y los informes) y se apagan las que el
 * local no use. La comisión de la chica por sección está en Reglas del local.
 */
export function SectionsPanel() {
  const { data, setData, error: loadError, retry } = useSettingsLoad(fetchSections);
  const { replace } = useSections();
  const [draft, setDraft] = useState<Record<string, { label: string; color: string; enabled: boolean }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, flashSaved] = useSavedFlash();

  if (!data) return <LoadState error={loadError} retry={retry} what="las secciones" />;
  const sections: VenueSection[] = data.map((s) => ({ ...s, ...(draft[s.code] ?? {}) }));
  const dirty = Object.keys(draft).length > 0;

  function edit(code: SectionCode, patch: Partial<{ label: string; color: string; enabled: boolean }>): void {
    const base = sections.find((s) => s.code === code)!;
    setDraft((prev) => ({ ...prev, [code]: { label: base.label, color: base.color, enabled: base.enabled, ...patch } }));
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const patch = Object.fromEntries(
        Object.entries(draft).map(([code, v]) => [code, { label: v.label.trim(), color: v.color, enabled: v.enabled }]),
      );
      const next = await updateSections({ sections: patch });
      setData(next);
      replace(next);
      setDraft({});
      flashSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="np-set-stack">
      <SettingsCard
        title="Secciones del local" tour="secciones-local"
        hint="Cada cobro va a su sección: la del servicio de la carta, la que toca quien cobra o la de su puesto. Apaga las que no uses."
      >
        <ul style={list}>
          {sections.map((s) => (
            <li key={s.code} style={row}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <SectionChip view={{ label: s.label || '—', color: s.enabled ? s.color : null, title: null }} />
                <input
                  type="color"
                  aria-label={`Color de ${s.label}`}
                  value={s.color}
                  disabled={busy}
                  onChange={(e) => edit(s.code, { color: e.target.value })}
                  style={colorInput}
                />
              </div>
              <Input
                aria-label={`Nombre de ${s.label}`}
                value={s.label}
                maxLength={24}
                disabled={busy}
                onChange={(e) => edit(s.code, { label: e.target.value })}
              />
              <Checkbox label="Se usa" checked={s.enabled} disabled={busy} onChange={(v) => edit(s.code, { enabled: v })} />
            </li>
          ))}
        </ul>
        <SaveRow onSave={() => void save()} busy={busy} saved={saved} error={error} disabled={!dirty} />
      </SettingsCard>
      <PostRulesCard />
      <InvitationRulesCard />
      <SettingsCard title="Además" tour="secciones-ademas" hint="No se eligen al cobrar: salen solas en los informes.">
        <p style={{ margin: 0, display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <SectionChip view={{ label: TIPS_SECTION_META.label, color: TIPS_SECTION_META.color, title: 'Las propinas de los clientes' }} />
          <SectionChip
            view={{ label: `${LEGACY_SECTION_META.label} (cobros antiguos)`, color: LEGACY_SECTION_META.color, title: 'Cobros de antes, sin sección' }}
          />
        </p>
      </SettingsCard>
    </div>
  );
}

const list: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.75rem' };
const row: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))',
  alignItems: 'center',
  gap: '0.5rem 1rem',
  padding: '0.75rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
};
const colorInput: CSSProperties = {
  width: '2.75rem',
  height: '2.75rem',
  padding: 0,
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  background: 'transparent',
  cursor: 'pointer',
};
