'use client';

import { useState, type FormEvent } from 'react';
import { Button, Card, Input, Modal, Select } from '@nightpay/ui';
import { businessCreateNeedsStepUp, type BusinessStatusValue, type CreateBusinessDto } from '@nightpay/contracts';
import { formatPercent } from '@/lib/commission';
import { createSaBusiness, fetchSaBusinesses } from '@/lib/endpoints/superadmin';
import { FILTER_FIELD, FILTER_SELECT } from '@/lib/filter-field';
import { EMPTY_BUSINESS_FORM, businessMoneyChanges, businessPayload, type BusinessForm } from '@/lib/superadmin/forms';
import { businessesQuery } from '@/lib/superadmin/query';
import { Pill } from '../Pill';
import { BusinessDetailView } from './BusinessDetail';
import { BusinessFields } from './BusinessFields';
import { useSa } from './context';
import { StepUpDialog } from './StepUpDialog';
import { LoadGate, SectionHead, SmallButton, ErrorLine, StickyActions } from './ui';
import { useDebounced, useLoad } from './use-load';

/** Negocios (clientes de OxioPay): lista y alta; tocar uno abre su ficha. */
export function BusinessesSection() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<BusinessStatusValue | ''>('');
  const [creating, setCreating] = useState(false);
  const sa = useSa();
  const query = businessesQuery({ q: useDebounced(q), status });
  const list = useLoad((signal) => fetchSaBusinesses(query, signal), [query]);

  if (openId) {
    return (
      <BusinessDetailView
        businessId={openId}
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
        kicker="Clientes de OxioPay"
        title="Negocios"
        sub="Cada negocio agrupa sus locales. Al pausarlo, ninguno de sus locales cobra."
        actions={<Button onClick={() => setCreating(true)}>+ Nuevo negocio</Button>}
      />
      <div className="np-sa-toolbar" role="search">
        <Input style={FILTER_FIELD}
          label="Buscar"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Nombre, NIF/CIF o email"
          type="search"
        />
        <Select style={FILTER_SELECT} label="Estado" value={status} onChange={(e) => setStatus(e.target.value as BusinessStatusValue | '')}>
          <option value="">Todos</option>
          <option value="ACTIVE">Cobrando</option>
          <option value="PAUSED">En pausa</option>
        </Select>
      </div>
      <LoadGate loaded={list} what="los negocios">
        {(businesses) =>
          businesses.length === 0 ? (
            <p className="np-sa-empty">{q || status ? 'Ningún negocio con ese filtro.' : 'Aún no hay negocios.'}</p>
          ) : (
            <Card className="np-table-host" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="np-sa-scroll-x">
                <table className="np-table">
                  <thead>
                    <tr>
                      <th>Negocio</th>
                      <th>NIF / CIF</th>
                      <th>Contacto</th>
                      <th>Locales</th>
                      <th>Comisión</th>
                      <th>Estado</th>
                      <th aria-label="Acciones" />
                    </tr>
                  </thead>
                  <tbody>
                    {businesses.map((b) => (
                      <tr key={b.id}>
                        <td data-label="Negocio" data-card="title">
                          {b.name}
                        </td>
                        <td data-label="NIF / CIF" className="np-sa-mono">
                          {b.taxId ?? '—'}
                        </td>
                        <td data-label="Contacto">
                          {[b.contactName, b.contactEmail, b.contactPhone].filter(Boolean).join(' · ') || '—'}
                        </td>
                        <td data-label="Locales" className="np-num">
                          {b.venueCount}
                        </td>
                        <td data-label="Comisión">
                          {b.defaultPlatformCommissionBps === null ? 'La general' : formatPercent(b.defaultPlatformCommissionBps)}
                        </td>
                        <td data-label="Estado" data-card="status">
                          {b.status === 'PAUSED' ? <Pill tone="warning">En pausa</Pill> : <Pill tone="success">Cobrando</Pill>}
                        </td>
                        <td data-label="" data-card="actions">
                          <SmallButton onClick={() => setOpenId(b.id)}>Abrir</SmallButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )
        }
      </LoadGate>
      {creating ? (
        <CreateBusinessDialog
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

function CreateBusinessDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [form, setForm] = useState<BusinessForm>(EMPTY_BUSINESS_FORM);
  /** Alta con comisión por defecto propia: espera al código 2FA (el formulario sigue detrás). */
  const [pending, setPending] = useState<CreateBusinessDto | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    const payload = businessPayload(form);
    if (!payload.ok) return setError(payload.error);
    setError(null);
    if (businessCreateNeedsStepUp(payload.value)) return setPending(payload.value);
    setSubmitting(true);
    try {
      const created = await createSaBusiness(payload.value);
      onCreated(created.id);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  if (pending) {
    return (
      <StepUpDialog
        title="Nuevo negocio"
        action="business.createMoney"
        summary={`Vas a dar de alta ${pending.name} con: ${businessMoneyChanges(null, pending).join('; ')}. Lo heredan sus locales nuevos.`}
        submitLabel="Dar de alta"
        onSubmit={async ({ totpCode }) => onCreated((await createSaBusiness(pending, totpCode)).id)}
        onClose={() => setPending(null)}
      />
    );
  }

  return (
    <Modal open onClose={submitting ? () => undefined : onClose} title="Nuevo negocio" width="40rem">
      <form className="np-sa-form" onSubmit={(e) => void handleSubmit(e)} noValidate>
        <BusinessFields form={form} onChange={setForm} disabled={submitting} />
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
