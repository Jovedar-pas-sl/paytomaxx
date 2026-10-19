'use client';

import { useState, type FormEvent } from 'react';
import { Button, Card, Input, Modal, Select } from '@nightpay/ui';
import { venueCreateNeedsStepUp, type CreateVenueDto } from '@nightpay/contracts';
import { createSaVenue, fetchSaVenues } from '@/lib/endpoints/superadmin';
import { EMPTY_VENUE_FORM, newVenuePayload, slugFromName, type NewVenueForm } from '@/lib/superadmin/forms';
import { commissionText, venuePauseLabel } from '@/lib/superadmin/labels';
import { venuesQuery, type VenueFilters } from '@/lib/superadmin/query';
import { Pill } from '../Pill';
import { useSa } from './context';
import { StepUpDialog } from './StepUpDialog';
import { VenueDetailView } from './VenueDetail';
import { ErrorLine, LoadGate, SectionHead, SmallButton, StickyActions } from './ui';
import { useDebounced, useLoad } from './use-load';

/** Todos los locales: lista con filtros y alta; tocar uno abre su ficha. */
export function VenuesSection() {
  const sa = useSa();
  const [openId, setOpenId] = useState<string | null>(null);
  const [filters, setFilters] = useState<VenueFilters>({ q: '', businessId: '', state: '' });
  const [creating, setCreating] = useState(false);
  const q = useDebounced(filters.q);
  const query = venuesQuery({ ...filters, q });
  const list = useLoad((signal) => fetchSaVenues(query, signal), [query]);

  if (openId) {
    return (
      <VenueDetailView
        venueId={openId}
        onBack={() => {
          setOpenId(null);
          list.reload();
        }}
      />
    );
  }

  return (
    <div className="np-sa-stack">
      <SectionHead
        kicker="Todos los locales"
        title="Locales"
        sub="Perfil, reglas de cobro, IBAN y pausa de cada local."
        actions={<Button onClick={() => setCreating(true)}>+ Nuevo local</Button>}
      />
      <div className="np-sa-toolbar" role="search">
        <Input
          label="Buscar"
          type="search"
          value={filters.q}
          onChange={(e) => setFilters({ ...filters, q: e.target.value })}
          placeholder="Nombre del local"
        />
        <Select
          label="Negocio"
          value={filters.businessId}
          onChange={(e) => setFilters({ ...filters, businessId: e.target.value })}
        >
          <option value="">Todos</option>
          {(sa.businesses ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
        <Select
          label="Estado"
          value={filters.state}
          onChange={(e) => setFilters({ ...filters, state: e.target.value as VenueFilters['state'] })}
        >
          <option value="">Todos</option>
          <option value="active">Cobrando</option>
          <option value="paused">En pausa</option>
        </Select>
      </div>
      <LoadGate loaded={list} what="los locales">
        {(venues) =>
          venues.length === 0 ? (
            <p className="np-sa-empty">Ningún local con ese filtro.</p>
          ) : (
            <Card className="np-table-host" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="np-sa-scroll-x">
                <table className="np-table">
                  <thead>
                    <tr>
                      <th>Local</th>
                      <th>Negocio</th>
                      <th>Zona horaria</th>
                      <th>Grupo del saldo</th>
                      <th>IBAN</th>
                      <th>Estado</th>
                      <th aria-label="Acciones" />
                    </tr>
                  </thead>
                  <tbody>
                    {venues.map((v) => {
                      const pause = venuePauseLabel(v);
                      return (
                        <tr key={v.id}>
                          <td data-label="Local" data-card="title">
                            {v.name}
                            {v.slug === sa.currentSlug ? (
                              <>
                                {' '}
                                <Pill tone="info">Estás aquí</Pill>
                              </>
                            ) : null}
                          </td>
                          <td data-label="Negocio">{v.business?.name ?? 'Sin negocio'}</td>
                          <td data-label="Zona horaria">{v.timezone}</td>
                          <td data-label="Grupo del saldo">{v.walletGroup ?? 'Ninguno'}</td>
                          <td data-label="IBAN" className="np-sa-mono">
                            {v.settlementIbanMasked ?? 'Sin IBAN'}
                          </td>
                          <td data-label="Estado" data-card="status">
                            {pause ? <Pill tone="warning">{pause}</Pill> : <Pill tone="success">Cobrando</Pill>}
                          </td>
                          <td data-label="" data-card="actions">
                            <SmallButton onClick={() => setOpenId(v.id)}>Abrir</SmallButton>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )
        }
      </LoadGate>
      {creating ? (
        <CreateVenueDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            sa.refreshLists();
            setOpenId(id);
          }}
        />
      ) : null}
    </div>
  );
}

function CreateVenueDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { businesses } = useSa();
  const [form, setForm] = useState<NewVenueForm>(EMPTY_VENUE_FORM);
  /** Alta con grupo del saldo o comisión propia: espera al código 2FA (el formulario sigue detrás). */
  const [pending, setPending] = useState<CreateVenueDto | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof NewVenueForm) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    const payload = newVenuePayload(form);
    if (!payload.ok) return setError(payload.error);
    setError(null);
    if (venueCreateNeedsStepUp(payload.value)) return setPending(payload.value);
    setSubmitting(true);
    try {
      const created = await createSaVenue(payload.value);
      onCreated(created.id);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  if (pending) {
    return (
      <StepUpDialog
        title="Nuevo local"
        action="venue.createMoney"
        summary={`Vas a dar de alta ${pending.name}${venueMoneyText(pending)}.`}
        submitLabel="Dar de alta"
        onSubmit={async ({ totpCode }) => onCreated((await createSaVenue(pending, totpCode)).id)}
        onClose={() => setPending(null)}
      />
    );
  }

  return (
    <Modal open onClose={submitting ? () => undefined : onClose} title="Nuevo local" width="40rem">
      <form className="np-sa-form" onSubmit={(e) => void handleSubmit(e)} noValidate>
        <div className="np-sa-grid-2">
          <Input label="Nombre" value={form.name} onChange={set('name')} placeholder="Luna Valencia" required autoFocus />
          <Input
            label="Nombre corto (dirección)"
            value={form.slug}
            onChange={set('slug')}
            placeholder={form.name ? slugFromName(form.name) : 'luna-vlc'}
            hint="Minúsculas y guiones. Vacío: se saca del nombre."
            autoComplete="off"
            spellCheck={false}
          />
          <Select label="Negocio" value={form.businessId} onChange={set('businessId')}>
            <option value="">Sin negocio</option>
            {(businesses ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
          <Input label="Zona horaria" value={form.timezone} onChange={set('timezone')} hint="Europe/Madrid, Atlantic/Canary…" />
          <Input
            label="Grupo del saldo"
            value={form.walletGroup}
            onChange={set('walletGroup')}
            placeholder="Ninguno"
            hint="Locales del mismo dueño con el mismo grupo comparten el saldo de los clientes."
            autoComplete="off"
            spellCheck={false}
          />
          <Input
            label="Comisión de la plataforma (%)"
            inputMode="decimal"
            value={form.commissionPct}
            onChange={set('commissionPct')}
            placeholder="La del negocio o la general"
          />
        </div>
        {error ? <ErrorLine>{error}</ErrorLine> : null}
        <StickyActions>
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button type="submit" loading={submitting}>
            Dar de alta
          </Button>
        </StickyActions>
      </form>
    </Modal>
  );
}

/** « con el grupo del saldo grupo-luna y una comisión del 8 %» (lo que pide la 2FA). */
function venueMoneyText(dto: CreateVenueDto): string {
  const parts = [
    dto.walletGroup ? `el grupo del saldo ${dto.walletGroup}` : null,
    dto.platformCommissionBps !== undefined ? `una comisión del ${commissionText(dto.platformCommissionBps)}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? ` con ${parts.join(' y ')}` : '';
}
