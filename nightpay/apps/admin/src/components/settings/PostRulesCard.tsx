'use client';

import { useState, type CSSProperties } from 'react';
import { PUESTOS, type PostCode, type PostRule, type SectionCode } from '@nightpay/contracts';
import { fetchPostRules, updatePostRules } from '@/lib/api';
import { enabledSections } from '@/lib/money-map';
import { useSections } from '@/lib/use-sections';
import { LoadState, SettingsCard, StatusLine, useSavedFlash, useSettingsLoad } from './SettingsBits';

const FLAGS: ReadonlyArray<{ key: 'tips' | 'cash' | 'topUps' | 'cashPayout'; label: string }> = [
  { key: 'tips', label: 'Propinas' },
  { key: 'cash', label: 'Efectivo' },
  { key: 'topUps', label: 'Recargas del saldo' },
  { key: 'cashPayout', label: 'Devolver saldo en efectivo' },
];

/**
 * Ajustes → Secciones → Qué cobra cada puesto (dueño): las secciones que
 * puede cobrar cada puesto, y si lleva propinas, cobra en efectivo o carga
 * saldos. Las chicas son siempre «Sala»; el dueño y el encargado lo pueden
 * todo. El API lo comprueba en cada cobro (403 si no).
 */
export function PostRulesCard() {
  const { data, setData, error: loadError, retry } = useSettingsLoad(fetchPostRules);
  const { sections } = useSections();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, flashSaved] = useSavedFlash();

  if (!data) return <LoadState error={loadError} retry={retry} what="los puestos" />;

  async function save(post: PostCode, change: Partial<PostRule>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setData(await updatePostRules({ posts: { [post]: change } }));
      flashSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function toggleSection(post: PostCode, code: SectionCode, on: boolean): void {
    if (!data) return;
    const current = data[post].sections;
    void save(post, { sections: on ? [...current, code] : current.filter((c) => c !== code) });
  }

  return (
    <SettingsCard
      title="Qué cobra cada puesto" tour="secciones-puestos"
      hint="Cada persona solo ve y solo puede cobrar lo de su puesto. Las chicas son siempre Sala. Tú y el encargado lo podéis todo."
    >
      <div style={grid}>
        {PUESTOS.map((p) => {
          const rule = data[p.code];
          return (
            <fieldset key={p.code} style={box} disabled={busy}>
              <legend style={legend}>
                {p.label}
                {p.code === 'SALA' ? <span style={dim}> · las chicas</span> : null}
              </legend>
              <div style={chips}>
                {enabledSections(sections).map((s) => (
                  <label key={s.code} style={{ ...chip, borderColor: s.color }}>
                    <input
                      type="checkbox"
                      checked={rule.sections.includes(s.code)}
                      onChange={(e) => toggleSection(p.code, s.code, e.target.checked)}
                    />
                    {s.label}
                  </label>
                ))}
              </div>
              <div style={chips}>
                {FLAGS.map((f) => (
                  <label key={f.key} style={chip}>
                    <input type="checkbox" checked={rule[f.key]} onChange={(e) => void save(p.code, { [f.key]: e.target.checked })} />
                    {f.label}
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}
      </div>
      <StatusLine saved={saved} error={error} />
    </SettingsCard>
  );
}

const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))', gap: '0.75rem' };
const box: CSSProperties = {
  margin: 0,
  padding: '0.75rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  minWidth: 0,
};
const legend: CSSProperties = { fontWeight: 600, padding: '0 0.25rem' };
const dim: CSSProperties = { color: 'var(--np-text-dim)', fontWeight: 500 };
const chips: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '0.375rem' };
const chip: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.375rem',
  // Chip de Grafito: radio 6, filete de 1 px y 36 px (44 en el móvil).
  minHeight: 'var(--np-filter-h)',
  padding: '0.25rem 0.625rem',
  border: '1px solid var(--np-border-hi)',
  borderRadius: 'var(--np-r-xs)',
  fontSize: '0.875rem',
  fontWeight: 500,
  cursor: 'pointer',
};
