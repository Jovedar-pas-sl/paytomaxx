'use client';

import { useState } from 'react';
import { Button, Card } from '@nightpay/ui';
import type { VenueSection } from '@nightpay/contracts';
import { createServiceItem, fetchCarta, updateServiceItem, type ServiceItem } from '@/lib/api';
import { cartaTemplatePlan } from '@/lib/carta-template';
import { formatEur } from '@/lib/money';

/** Aplicación explícita por local: nunca se ejecuta al desplegar o al abrir la pantalla. */
export function CartaTemplate({ items, sections, onApplied }: {
  items: ServiceItem[];
  sections: VenueSection[];
  onApplied: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plan = cartaTemplatePlan(items);
  const off = [...new Set(plan.map((p) => p.input.category))]
    .filter((code) => !sections.some((s) => s.code === code && s.enabled));
  const conflicts = plan.some((p) => p.action === 'conflict');
  const changes = plan.filter((p) => p.action !== 'keep');

  async function apply() {
    setBusy(true);
    setError(null);
    setMessage(null);
    let done = 0;
    try {
      const fresh = cartaTemplatePlan(await fetchCarta());
      if (fresh.some((p) => p.action === 'conflict')) throw new Error('Revisa los productos duplicados, packs o invitaciones antes de aplicar.');
      for (const p of fresh) {
        if (p.action === 'keep') continue;
        if (p.existing) await updateServiceItem(p.existing.id, { ...p.input, active: true });
        else await createServiceItem(p.input);
        done++;
      }
      setMessage('Carta aplicada. Puedes ajustar cada producto abajo. Las propinas se configuran en Ajustes → Formas de cobro.');
    } catch (err) {
      setError(`${done > 0 ? `${done} productos guardados. ` : ''}${(err as Error).message} Puedes reintentar para completar los que falten.`);
    } finally {
      setBusy(false);
      onApplied();
    }
  }

  return (
    <Card style={{ padding: '1.25rem' }}>
      <details open={items.length === 0 ? true : undefined}>
        <summary style={{ cursor: 'pointer', fontWeight: 700, minHeight: '2.75rem' }}>Carta de referencia · productos y precios</summary>
        <p>Se añaden los productos que faltan y se actualizan precio, duración y orden de las coincidencias. Se reactivan si estaban desactivadas. Los demás productos se conservan.</p>
        <ul style={{ paddingLeft: '1.25rem', display: 'grid', gap: '0.5rem' }}>
          {plan.map((p) => (
            <li key={`${p.input.category}-${p.input.name}`}>
              {p.input.name} · <b>{formatEur(p.input.priceCents)}</b>
              {' · '}{({ create: 'Añadir', update: 'Actualizar', keep: 'Ya configurado', conflict: 'Revisar coincidencias' })[p.action]}
              {p.action === 'update' && p.existing?.priceCents !== p.input.priceCents ? ` (antes ${formatEur(p.existing!.priceCents)})` : ''}
            </li>
          ))}
        </ul>
        {off.length > 0 ? <p role="status">Activa primero estas secciones en Ajustes: {off.map((c) => sections.find((s) => s.code === c)?.label ?? c).join(', ')}.</p> : null}
        {conflicts ? <p role="status">Revisa las coincidencias indicadas antes de aplicar: hay nombres duplicados, packs o invitaciones.</p> : null}
        <Button disabled={busy || conflicts || off.length > 0 || changes.length === 0} loading={busy} onClick={() => void apply()}>
          {changes.length === 0 ? 'Carta ya configurada' : 'Aplicar productos y precios'}
        </Button>
      </details>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert" style={{ color: 'var(--np-danger)' }}>{error}</p> : null}
    </Card>
  );
}
