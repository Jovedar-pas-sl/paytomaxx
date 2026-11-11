'use client';

import { useState } from 'react';
import { Button, Card, Input, Select } from '@nightpay/ui';
import type { CreateStaffUserResponse, Role, StaffUserPage, StaffUserView } from '@nightpay/contracts';
import { createSaUser, fetchSaUsers } from '@/lib/endpoints/superadmin';
import { FILTER_FIELD, FILTER_SELECT } from '@/lib/filter-field';
import { SA_ROLES, SA_ROLE_LABELS, lastAccessText, personName } from '@/lib/superadmin/labels';
import { EMPTY_PERSON_FORM, newPersonPayload, type NewPersonForm } from '@/lib/superadmin/person-forms';
import { EMPTY_STAFF_FILTERS, staffQuery, type StaffFilters } from '@/lib/superadmin/query';
import { useVenueTimezone } from '@/lib/venue-context';
import { Pill } from '../Pill';
import { useSa } from './context';
import { InviteResult, PersonActionsDialog } from './PersonActions';
import { ResultDialog, StepUpDialog } from './StepUpDialog';
import { CheckRow, LoadGate, SectionHead, SmallButton } from './ui';
import { useDebounced, useLoad } from './use-load';

interface ExtraPages {
  forQuery: string;
  items: StaffUserView[];
  nextCursor: string | null;
}

/** Personas de todos los locales: buscar, filtrar, dar de alta y sus acciones. */
export function PeopleSection() {
  const sa = useSa();
  const tz = useVenueTimezone();
  const [filters, setFilters] = useState<StaffFilters>(EMPTY_STAFF_FILTERS);
  const q = useDebounced(filters.q);
  const firstQuery = staffQuery({ ...filters, q });
  const first = useLoad((signal) => fetchSaUsers(firstQuery, signal), [firstQuery]);
  const [extra, setExtra] = useState<ExtraPages | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  /** Lo que devolvió una acción (baja, 2FA…), encima de lo de la lista. */
  const [changed, setChanged] = useState<Readonly<Record<string, StaffUserView>>>({});
  const [acting, setActing] = useState<StaffUserView | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreateStaffUserResponse | null>(null);

  const more = extra?.forQuery === firstQuery ? extra : null;

  async function loadMore(page: StaffUserPage): Promise<void> {
    const cursor = more ? more.nextCursor : page.nextCursor;
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await fetchSaUsers(staffQuery({ ...filters, q }, cursor));
      setExtra({ forQuery: firstQuery, items: [...(more?.items ?? []), ...next.items], nextCursor: next.nextCursor });
    } catch (err) {
      setMoreError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  function onUpdated(user: StaffUserView): void {
    setChanged((prev) => ({ ...prev, [user.id]: user }));
  }

  return (
    <div className="np-sa-stack">
      <SectionHead
        kicker="Todos los locales"
        title="Personas"
        sub="Dueños, encargados, camareros y compañeras. Las acciones delicadas piden tu código 2FA."
        actions={<Button onClick={() => setCreating(true)}>+ Nueva persona</Button>}
      />
      <div className="np-sa-toolbar" role="search">
        <Input style={FILTER_FIELD}
          label="Buscar"
          type="search"
          value={filters.q}
          onChange={(e) => setFilters({ ...filters, q: e.target.value })}
          placeholder="Nombre o email"
        />
        <Select style={FILTER_SELECT} label="Local" value={filters.venueId} onChange={(e) => setFilters({ ...filters, venueId: e.target.value })}>
          <option value="">Todos</option>
          {(sa.venues ?? []).map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </Select>
        <Select style={FILTER_SELECT}
          label="Rol"
          value={filters.role}
          onChange={(e) => setFilters({ ...filters, role: e.target.value as Role | '' })}
        >
          <option value="">Todos</option>
          {SA_ROLES.map((r) => (
            <option key={r} value={r}>
              {SA_ROLE_LABELS[r]}
            </option>
          ))}
        </Select>
        <Select style={FILTER_SELECT}
          label="Estado"
          value={filters.state}
          onChange={(e) => setFilters({ ...filters, state: e.target.value as StaffFilters['state'] })}
        >
          <option value="">Todas</option>
          <option value="active">De alta</option>
          <option value="inactive">De baja</option>
        </Select>
        <CheckRow
          checked={filters.onlySuperAdmins}
          onChange={(on) => setFilters({ ...filters, onlySuperAdmins: on })}
          label="Solo super-admins"
        />
      </div>

      <LoadGate loaded={first} what="las personas">
        {(page) => {
          const rows = [...page.items, ...(more?.items ?? [])].map((u) => changed[u.id] ?? u);
          const hasMore = Boolean(more ? more.nextCursor : page.nextCursor);
          if (rows.length === 0) return <p className="np-sa-empty">Nadie con ese filtro.</p>;
          return (
            <>
              <Card className="np-table-host" style={{ padding: 0, overflow: 'hidden' }}>
                <div className="np-sa-scroll-x">
                  <table className="np-table">
                    <thead>
                      <tr>
                        <th>Persona</th>
                        <th>Rol</th>
                        <th>Local</th>
                        <th>Último acceso</th>
                        <th>2FA</th>
                        <th>Estado</th>
                        <th>Super-admin</th>
                        <th aria-label="Acciones" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((u) => (
                        <tr key={u.id}>
                          <td data-label="Persona" data-card="title">
                            <span className="np-sa-cell-stack">
                              <span>{personName(u)}</span>
                              {u.displayName ? <span className="np-sa-dim np-sa-small">{u.email}</span> : null}
                            </span>
                          </td>
                          <td data-label="Rol">{SA_ROLE_LABELS[u.role]}</td>
                          <td data-label="Local">{u.venue.name}</td>
                          <td data-label="Último acceso">{lastAccessText(u.lastLoginAt, tz)}</td>
                          <td data-label="2FA">
                            {u.totpEnabled ? <Pill tone="success">Activada</Pill> : <Pill tone="neutral">No</Pill>}
                          </td>
                          <td data-label="Estado">
                            <PersonState user={u} />
                          </td>
                          <td data-label="Super-admin">{u.isSuperAdmin ? <Pill tone="info">Sí</Pill> : '—'}</td>
                          <td data-label="" data-card="actions">
                            <SmallButton onClick={() => setActing(u)}>Acciones</SmallButton>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              {moreError ? <p className="np-sa-error">No se pudieron cargar más: {moreError}</p> : null}
              {hasMore ? (
                <Button variant="ghost" onClick={() => void loadMore(page)} loading={loadingMore}>
                  Cargar más
                </Button>
              ) : null}
            </>
          );
        }}
      </LoadGate>

      {acting ? (
        <PersonActionsDialog person={acting} onUpdated={onUpdated} onClose={() => setActing(null)} />
      ) : null}
      {creating ? (
        <CreatePersonDialog
          onClose={() => setCreating(false)}
          onCreated={(res) => {
            setCreating(false);
            setCreated(res);
            first.reload();
          }}
        />
      ) : null}
      {created ? (
        <ResultDialog title="Persona dada de alta" onClose={() => setCreated(null)}>
          <InviteResult
            who={personName(created.user)}
            url={created.inviteUrl}
            expiresAt={created.expiresAt}
            emailSent={created.emailSent}
          />
        </ResultDialog>
      ) : null}
    </div>
  );
}

function PersonState({ user }: { user: StaffUserView }) {
  if (!user.active) return <Pill tone="danger">De baja</Pill>;
  if (user.invitePending) return <Pill tone="warning">Invitación pendiente</Pill>;
  return <Pill tone="success">Activa</Pill>;
}

function CreatePersonDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (res: CreateStaffUserResponse) => void;
}) {
  const { venues } = useSa();
  const [form, setForm] = useState<NewPersonForm>(EMPTY_PERSON_FORM);
  const set = (key: keyof NewPersonForm) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });
  const payload = newPersonPayload(form);
  const venueName = venues?.find((v) => v.id === form.venueId)?.name ?? 'el local';
  const roleName = form.role ? SA_ROLE_LABELS[form.role].toLowerCase() : 'persona';

  return (
    <StepUpDialog
      title="Nueva persona"
      action="user.create"
      summary={`Vas a dar de alta a ${form.email.trim() || '…'} como ${roleName} en ${venueName}. Recibirá un enlace (24 h) para poner su contraseña.`}
      validate={() => (payload.ok ? null : payload.error)}
      submitLabel="Dar de alta"
      width="36rem"
      onSubmit={async ({ totpCode }) => {
        if (!payload.ok) throw new Error(payload.error);
        onCreated(await createSaUser(payload.value, totpCode));
      }}
      onClose={onClose}
    >
      <div className="np-sa-grid-2">
        <Select label="Local" value={form.venueId} onChange={set('venueId')} required>
          <option value="">— Elige el local —</option>
          {(venues ?? []).map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </Select>
        <Select label="Qué es" value={form.role} onChange={set('role')} required>
          <option value="">— Elige —</option>
          {SA_ROLES.map((r) => (
            <option key={r} value={r}>
              {SA_ROLE_LABELS[r]}
            </option>
          ))}
        </Select>
        <Input
          label="Email"
          type="email"
          inputMode="email"
          value={form.email}
          onChange={set('email')}
          autoComplete="off"
          required
        />
        <Input
          label={form.role === 'OPERATOR' ? 'Nombre (lo verán los clientes)' : 'Nombre · opcional'}
          value={form.displayName}
          onChange={set('displayName')}
          maxLength={80}
        />
        {form.role === 'OPERATOR' ? (
          <Input
            label="Su comisión (%) · opcional"
            inputMode="decimal"
            value={form.commissionPct}
            onChange={set('commissionPct')}
            placeholder="La del local"
            hint="Solo si esta compañera cobra distinto que las demás."
          />
        ) : null}
      </div>
    </StepUpDialog>
  );
}
