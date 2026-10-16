'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card, Modal } from '@nightpay/ui';
import type { BusinessDetail } from '@nightpay/contracts';
import {
  assignSaVenues,
  fetchSaBusiness,
  pauseSaBusiness,
  resumeSaBusiness,
  unassignSaVenue,
  updateSaBusiness,
} from '@/lib/endpoints/superadmin';
import { businessChanges, businessFormFrom, businessPayload, type BusinessForm } from '@/lib/superadmin/forms';
import { venuePauseLabel } from '@/lib/superadmin/labels';
import { Pill } from '../Pill';
import { BusinessFields } from './BusinessFields';
import { useSa } from './context';
import { PauseCard } from './PauseCard';
import { BackButton, CheckRow, ErrorLine, LoadGate, SectionHead, SmallButton, StickyActions } from './ui';
import { useLoad } from './use-load';

interface Props {
  businessId: string;
  onBack: () => void;
}

/** Ficha de un negocio: datos, sus locales (meter y sacar) y la pausa. */
export function BusinessDetailView({ businessId, onBack }: Props) {
  const detail = useLoad((signal) => fetchSaBusiness(businessId, signal), [businessId]);
  const sa = useSa();

  function replace(next: Partial<BusinessDetail>): void {
    detail.setData((prev) => (prev ? { ...prev, ...next } : prev));
    sa.refreshLists();
  }

  return (
    <div className="np-sa-stack np-sa-detail">
      <BackButton onClick={onBack}>Todos los negocios</BackButton>
      <LoadGate loaded={detail} what="el negocio">
        {(b) => (
          <>
            <SectionHead
              kicker="Negocio"
              title={b.name}
              sub={b.taxId ? `NIF/CIF ${b.taxId}` : 'Sin NIF/CIF'}
              actions={b.status === 'PAUSED' ? <Pill tone="warning">En pausa</Pill> : <Pill tone="success">Cobrando</Pill>}
            />
            <BusinessDataCard business={b} onSaved={replace} />
            <BusinessVenuesCard business={b} onChanged={(next) => replace(next)} />
            <PauseCard
              kind="business"
              name={b.name}
              paused={b.status === 'PAUSED'}
              pausedAt={b.pausedAt}
              pausedReason={b.pausedReason}
              venueCount={b.venues.length}
              onPause={async (input) => replace(await pauseSaBusiness(b.id, input))}
              onResume={async (input) => replace(await resumeSaBusiness(b.id, input))}
            />
          </>
        )}
      </LoadGate>
    </div>
  );
}

function BusinessDataCard({
  business,
  onSaved,
}: {
  business: BusinessDetail;
  onSaved: (next: Partial<BusinessDetail>) => void;
}) {
  const [form, setForm] = useState<BusinessForm>(() => businessFormFrom(business));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Tras guardar (o si cambió fuera), el formulario enseña lo guardado.
  useEffect(() => {
    setForm(businessFormFrom(business));
  }, [business.updatedAt]);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setSaved(false);
    const payload = businessPayload(form);
    if (!payload.ok) return setError(payload.error);
    const changes = businessChanges(business, payload.value);
    if (Object.keys(changes).length === 0) return setError('No has cambiado nada.');
    setError(null);
    setSubmitting(true);
    try {
      onSaved(await updateSaBusiness(business.id, changes));
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <form className="np-sa-form" onSubmit={(e) => void handleSubmit(e)} noValidate>
        <SectionHead level={3} title="Datos del negocio" />
        <BusinessFields form={form} onChange={(next) => {
          setForm(next);
          setSaved(false);
        }} disabled={submitting} />
        {error ? <ErrorLine>{error}</ErrorLine> : null}
        {saved ? (
          <p role="status" className="np-sa-ok">
            Guardado.
          </p>
        ) : null}
        <StickyActions>
          <Button type="submit" loading={submitting}>
            Guardar cambios
          </Button>
        </StickyActions>
      </form>
    </Card>
  );
}

function BusinessVenuesCard({
  business,
  onChanged,
}: {
  business: BusinessDetail;
  onChanged: (next: BusinessDetail) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

  return (
    <Card>
      <div className="np-sa-stack-sm">
        <SectionHead
          level={3}
          title="Locales"
          sub={business.venues.length === 0 ? 'Este negocio aún no tiene locales.' : undefined}
          actions={<SmallButton onClick={() => setAdding(true)}>+ Añadir locales</SmallButton>}
        />
        {business.venues.length > 0 ? (
          <ul className="np-sa-rows">
            {business.venues.map((v) => {
              const pause = venuePauseLabel(v);
              return (
                <li key={v.id} className="np-sa-row">
                  <span className="np-sa-row-main">
                    <strong>{v.name}</strong>
                    <span className="np-sa-mono np-sa-dim">{v.slug}</span>
                    {pause ? <Pill tone="warning">{pause}</Pill> : null}
                  </span>
                  <SmallButton onClick={() => setRemoving({ id: v.id, name: v.name })}>Sacar</SmallButton>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      {adding ? (
        <AssignVenuesDialog
          business={business}
          onClose={() => setAdding(false)}
          onDone={(next) => {
            setAdding(false);
            onChanged(next);
          }}
        />
      ) : null}
      {removing ? (
        <UnassignDialog
          business={business}
          venue={removing}
          onClose={() => setRemoving(null)}
          onDone={(next) => {
            setRemoving(null);
            onChanged(next);
          }}
        />
      ) : null}
    </Card>
  );
}

function AssignVenuesDialog({
  business,
  onClose,
  onDone,
}: {
  business: BusinessDetail;
  onClose: () => void;
  onDone: (next: BusinessDetail) => void;
}) {
  const { venues } = useSa();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = (venues ?? []).filter((v) => v.business?.id !== business.id);

  function toggle(id: string, on: boolean): void {
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (picked.size === 0) return setError('Marca al menos un local.');
    setSubmitting(true);
    setError(null);
    try {
      onDone(await assignSaVenues(business.id, [...picked]));
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={submitting ? () => undefined : onClose} title={`Añadir locales a ${business.name}`} width="32rem">
      <form className="np-sa-form" onSubmit={(e) => void handleSubmit(e)}>
        {venues === null ? (
          <p className="np-sa-loading">Cargando los locales…</p>
        ) : candidates.length === 0 ? (
          <p className="np-sa-empty">Todos los locales ya son de este negocio.</p>
        ) : (
          <div className="np-sa-stack-sm">
            {candidates.map((v) => (
              <CheckRow
                key={v.id}
                checked={picked.has(v.id)}
                onChange={(on) => toggle(v.id, on)}
                label={v.name}
                help={v.business ? `Ahora es de ${v.business.name}: se cambia a este.` : 'Sin negocio.'}
                disabled={submitting}
              />
            ))}
          </div>
        )}
        {error ? <ErrorLine>{error}</ErrorLine> : null}
        <StickyActions>
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button type="submit" loading={submitting} disabled={picked.size === 0}>
            Añadir {picked.size > 0 ? picked.size : ''}
          </Button>
        </StickyActions>
      </form>
    </Modal>
  );
}

function UnassignDialog({
  business,
  venue,
  onClose,
  onDone,
}: {
  business: BusinessDetail;
  venue: { id: string; name: string };
  onClose: () => void;
  onDone: (next: BusinessDetail) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      onDone(await unassignSaVenue(business.id, venue.id));
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={submitting ? () => undefined : onClose} title="Sacar el local del negocio" width="28rem">
      <div className="np-sa-form">
        <p className="np-sa-text">
          {venue.name} deja de ser de {business.name}. El local sigue funcionando igual; si el negocio está en pausa,
          esa pausa ya no le afecta.
        </p>
        {error ? <ErrorLine>{error}</ErrorLine> : null}
        <StickyActions>
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button type="button" onClick={() => void confirm()} loading={submitting}>
            Sacar del negocio
          </Button>
        </StickyActions>
      </div>
    </Modal>
  );
}
