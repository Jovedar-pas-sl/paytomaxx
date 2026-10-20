'use client';

import { useState, type CSSProperties } from 'react';
import { Select } from '@nightpay/ui';
import { PUESTOS, isPostCode, rolePost, type PostCode, type PuestoPerson } from '@nightpay/contracts';
import { fetchPuestos, updatePuesto } from '@/lib/api';
import { sectionLabelOf } from '@/lib/money-map';
import { useSections } from '@/lib/use-sections';
import { LoadState, SettingsCard, StatusLine, useSavedFlash, useSettingsLoad } from './SettingsBits';

const ROLE_NAME: Record<PuestoPerson['role'], string> = { MANAGER: 'Encargado', WAITER: 'Camarero', OPERATOR: 'Chica' };

/**
 * Ajustes → Permisos → Puestos (dueño): el puesto de cada persona (Sala,
 * Barra, Habitaciones, Cocina, Recepción) decide la sección de sus cobros
 * cuando no la dice la carta: su app la marca en «Otro importe».
 */
export function PuestosCard() {
  const { data, setData, error: loadError, retry } = useSettingsLoad(fetchPuestos);
  const { sections } = useSections();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, flashSaved] = useSavedFlash();

  if (!data) return <LoadState error={loadError} retry={retry} what="los puestos" />;

  async function change(person: PuestoPerson, raw: string): Promise<void> {
    if (!data) return;
    const post: PostCode | null = isPostCode(raw) ? raw : null;
    setBusy(person.id);
    setError(null);
    try {
      const updated = await updatePuesto(person.id, post);
      setData(data.map((p) => (p.id === updated.id ? updated : p)));
      flashSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const option = (code: PostCode) => {
    const p = PUESTOS.find((x) => x.code === code)!;
    return `${p.label} → ${sectionLabelOf(sections, p.section)}`;
  };

  return (
    <SettingsCard
      title="Puestos"
      hint="La sección que marca la app de cada persona al teclear un importe. Sin puesto, el de su rol: la chica, Sala; el resto, Barra."
    >
      {data.length === 0 ? (
        <p className="np-set-loading">Aún no hay personal en el local.</p>
      ) : (
        <ul style={list}>
          {data.map((p) => (
            <li key={p.id} style={row}>
              <span style={{ fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere' }}>
                {p.name} <span style={{ color: 'var(--np-text-dim)', fontWeight: 500 }}>· {ROLE_NAME[p.role]}</span>
              </span>
              <Select
                aria-label={`Puesto de ${p.name}`}
                value={p.post ?? ''}
                disabled={busy === p.id}
                onChange={(e) => void change(p, e.target.value)}
              >
                <option value="">Según su rol ({option(rolePost(p.role))})</option>
                {PUESTOS.map((x) => (
                  <option key={x.code} value={x.code}>
                    {option(x.code)}
                  </option>
                ))}
              </Select>
            </li>
          ))}
        </ul>
      )}
      <StatusLine saved={saved} error={error} />
      <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--np-text-dim)' }}>
        {data.filter((p) => p.post).length} de {data.length} con puesto propio.
      </p>
    </SettingsCard>
  );
}

const list: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' };
const row: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))',
  alignItems: 'center',
  gap: '0.5rem 1rem',
};
