'use client';

import { useState } from 'react';
import { Button, Card } from '@nightpay/ui';
import type { ApplyCartaTemplateResult, VenueSection } from '@nightpay/contracts';
import { applyCartaTemplate, type ServiceItem } from '@/lib/api';
import { ApiError } from '@/lib/api-errors';
import {
  cartaTemplatePlan,
  templateButtonLabel,
  templateDiffText,
  templateSkipText,
  templateUpdates,
  type TemplateChange,
} from '@/lib/carta-template';
import { formatEur } from '@/lib/money';

const STATE: Readonly<Record<TemplateChange['action'], { label: string; tone: string }>> = {
  create: { label: 'Se añade', tone: 'add' },
  keep: { label: 'Ya lo tienes igual', tone: 'keep' },
  update: { label: 'Lo tienes distinto', tone: 'diff' },
  skip: { label: 'Se omite', tone: 'skip' },
};

/**
 * La carta de referencia, aplicada a mano por local (nunca al desplegar ni al
 * abrir la pantalla). Por defecto solo añade lo que falta; un producto que ya
 * existe solo cambia si se marca aquí, viendo qué cambia y por qué.
 */
export function CartaTemplate({ items, sections, onApplied }: {
  items: ServiceItem[];
  sections: VenueSection[];
  onApplied: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const plan = cartaTemplatePlan(items, { sections });
  const creates = plan.filter((p) => p.action === 'create').length;
  const updates = templateUpdates(plan, ticked);

  function toggle(id: string, on: boolean) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function apply() {
    if (busy || creates + updates.length === 0) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await applyCartaTemplate(updates);
      setTicked(new Set());
      setMessage(resultText(result));
    } catch (err) {
      const stale = err instanceof ApiError && err.status === 409;
      // Lo marcado se vio antes del cambio: se vuelve a mirar y a marcar.
      if (stale) setTicked(new Set());
      setError(`${(err as Error).message}${stale ? '' : ' No se ha cambiado nada: puedes reintentar.'}`);
    } finally {
      setBusy(false);
      onApplied();
    }
  }

  return (
    <Card style={{ padding: '1.25rem' }}>
      <details className="np-tpl" open={items.length === 0 ? true : undefined}>
        <summary>Carta de referencia · productos y precios</summary>
        <p className="np-tpl-intro">
          Añade los productos que te faltan con su precio de referencia. Lo que ya tienes no se toca: si quieres igualar
          un producto a la referencia, márcalo. «Copa» es la copa normal y, justo después, «Copa con invitación» por
          20 € (se escanea el QR de la chica; su reparto, en Ajustes → Secciones → Invitaciones).
        </p>
        <ul className="np-tpl-list">
          {plan.map((p) => (
            <TemplateRow
              key={`${p.input.category}-${p.input.name}`}
              change={p}
              sections={sections}
              ticked={Boolean(p.existing && ticked.has(p.existing.id))}
              disabled={busy}
              onTick={(on) => p.existing && toggle(p.existing.id, on)}
            />
          ))}
        </ul>
        <Button disabled={busy || creates + updates.length === 0} loading={busy} onClick={() => void apply()}>
          {templateButtonLabel(creates, updates.length)}
        </Button>
      </details>
      {message ? <p role="status" className="np-tpl-msg">{message}</p> : null}
      {error ? <p role="alert" className="np-tpl-msg" data-tone="danger">{error}</p> : null}
    </Card>
  );
}

function TemplateRow({ change, sections, ticked, disabled, onTick }: {
  change: TemplateChange<ServiceItem>;
  sections: readonly VenueSection[];
  ticked: boolean;
  disabled: boolean;
  onTick: (on: boolean) => void;
}) {
  const state = STATE[change.action];
  const name = change.existing?.name.trim() || change.input.name;
  return (
    <li className="np-tpl-row" data-tone={state.tone}>
      <div className="np-tpl-head">
        <b>{name}</b>
        <span className="np-num" title="Precio de referencia">ref. {formatEur(change.input.priceCents)}</span>
        <span className="np-tpl-state">{state.label}</span>
      </div>
      {change.action === 'skip' ? <p className="np-tpl-why">{templateSkipText(change, sections)}</p> : null}
      {change.action === 'update' ? (
        <label className="np-tpl-tick">
          <input type="checkbox" checked={ticked} disabled={disabled} onChange={(event) => onTick(event.target.checked)} />
          <span>
            Ponerlo como la referencia
            <ul>
              {change.diffs.map((d) => <li key={d.field}>{templateDiffText(d)}</li>)}
            </ul>
          </span>
        </label>
      ) : null}
    </li>
  );
}

function resultText(r: ApplyCartaTemplateResult): string {
  const parts = [
    r.created ? `${r.created} añadidos` : null,
    r.updated ? `${r.updated} actualizados` : null,
    r.kept ? `${r.kept} como estaban` : null,
    r.skipped ? `${r.skipped} omitidos` : null,
  ].filter(Boolean);
  return `Carta aplicada: ${parts.join(' · ') || 'sin cambios'}. Puedes ajustar cada producto abajo. Las propinas, en Ajustes → Formas de cobro.`;
}
