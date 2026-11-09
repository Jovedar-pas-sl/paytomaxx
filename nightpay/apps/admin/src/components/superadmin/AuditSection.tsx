'use client';

import { useState } from 'react';
import { Button, Card, Input, Select } from '@nightpay/ui';
import type { AuditEventPage, AuditEventView } from '@nightpay/contracts';
import { formatDateTime } from '@/lib/dates';
import { fetchSaAudit, fetchSaUsers } from '@/lib/endpoints/superadmin';
import { FILTER_FIELD, FILTER_SELECT } from '@/lib/filter-field';
import { AUDIT_ACTION_FILTERS, auditActionLabel, auditReason, isSuperAdminAction } from '@/lib/superadmin/audit-actions';
import { personName } from '@/lib/superadmin/labels';
import { EMPTY_AUDIT_FILTERS, auditQuery, auditRangeProblem, type AuditFilters } from '@/lib/superadmin/query';
import { useVenueTimezone } from '@/lib/venue-context';
import { Pill } from '../Pill';
import { useSa } from './context';
import { ErrorLine, LoadGate, SectionHead, SmallButton } from './ui';
import { useLoad } from './use-load';

/** Personas para el filtro «Quién» (las primeras 200 por email). */
const PEOPLE_FOR_FILTER = '?limit=200';

interface Props {
  /** Abierto desde «Ver lo que ha hecho» de una persona. */
  actor: { id: string; label: string } | null;
}

interface ExtraPages {
  forQuery: string;
  items: AuditEventView[];
  nextCursor: string | null;
}

/** Registro de todos los locales: quién hizo qué, cuándo y por qué. */
export function AuditSection({ actor }: Props) {
  const sa = useSa();
  const [filters, setFilters] = useState<AuditFilters>({ ...EMPTY_AUDIT_FILTERS, actorId: actor?.id ?? '' });
  const people = useLoad((signal) => fetchSaUsers(PEOPLE_FOR_FILTER, signal), []);
  const rangeProblem = auditRangeProblem(filters);
  // Con las fechas al revés se avisa y se busca sin fechas.
  const effective = rangeProblem ? { ...filters, from: '', to: '' } : filters;
  const firstQuery = auditQuery(effective);
  const first = useLoad((signal) => fetchSaAudit(firstQuery, signal), [firstQuery]);
  const [extra, setExtra] = useState<ExtraPages | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const more = extra?.forQuery === firstQuery ? extra : null;

  const peopleOptions = [
    ...(actor && !people.data?.items.some((p) => p.id === actor.id) ? [{ id: actor.id, label: actor.label }] : []),
    ...(people.data?.items ?? []).map((p) => ({ id: p.id, label: `${personName(p)} · ${p.venue.name}` })),
  ];

  async function loadMore(page: AuditEventPage): Promise<void> {
    const cursor = more ? more.nextCursor : page.nextCursor;
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await fetchSaAudit(auditQuery(effective, cursor));
      setExtra({ forQuery: firstQuery, items: [...(more?.items ?? []), ...next.items], nextCursor: next.nextCursor });
    } catch (err) {
      setMoreError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="np-sa-stack">
      <SectionHead
        kicker="Todos los locales"
        title="Registro"
        sub="Quién hizo qué y cuándo. Lo secreto (contraseñas, IBAN, cuentas) sale tapado."
      />
      <div className="np-sa-toolbar" role="search">
        <Select style={FILTER_SELECT} label="Local" value={filters.venueId} onChange={(e) => setFilters({ ...filters, venueId: e.target.value })}>
          <option value="">Todos</option>
          {(sa.venues ?? []).map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </Select>
        <Select style={FILTER_SELECT} label="Quién" value={filters.actorId} onChange={(e) => setFilters({ ...filters, actorId: e.target.value })}>
          <option value="">Todos</option>
          {peopleOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </Select>
        <Select style={FILTER_SELECT} label="Qué" value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })}>
          {AUDIT_ACTION_FILTERS.map((f) => (
            <option key={f.value || 'all'} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
        <Input style={FILTER_FIELD}
          label="Desde"
          type="date"
          value={filters.from}
          onChange={(e) => setFilters({ ...filters, from: e.target.value })}
        />
        <Input style={FILTER_FIELD} label="Hasta" type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
      </div>
      {rangeProblem ? <ErrorLine>{rangeProblem}</ErrorLine> : null}

      <LoadGate loaded={first} what="el registro">
        {(page) => {
          const rows = [...page.items, ...(more?.items ?? [])];
          const hasMore = Boolean(more ? more.nextCursor : page.nextCursor);
          if (rows.length === 0) return <p className="np-sa-empty">Nada en el registro con esos filtros.</p>;
          return (
            <>
              <Card className="np-table-host" style={{ padding: 0, overflow: 'hidden' }}>
                <div className="np-sa-scroll-x">
                  <table className="np-table">
                    <thead>
                      <tr>
                        <th>Cuándo</th>
                        <th>Qué</th>
                        <th>Quién</th>
                        <th>Local</th>
                        <th>Motivo</th>
                        <th aria-label="Detalles" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((ev) => (
                        <AuditRow key={ev.id} event={ev} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              {moreError ? <p className="np-sa-error">No se pudo cargar más: {moreError}</p> : null}
              {hasMore ? (
                <Button variant="ghost" onClick={() => void loadMore(page)} loading={loadingMore}>
                  Cargar más
                </Button>
              ) : null}
            </>
          );
        }}
      </LoadGate>
    </div>
  );
}

function AuditRow({ event }: { event: AuditEventView }) {
  const tz = useVenueTimezone();
  const [open, setOpen] = useState(false);
  const reason = auditReason(event.payload);
  return (
    <tr>
      <td data-label="Cuándo" data-card="top" className="np-sa-nowrap">
        {formatDateTime(event.occurredAt, tz, 'datetime')}
      </td>
      <td data-label="Qué" data-card="title">
        <span className="np-sa-cell-stack">
          <span>
            {auditActionLabel(event.action)}{' '}
            {isSuperAdminAction(event.action) ? <Pill tone="info">Super-admin</Pill> : null}
          </span>
          {open ? <span className="np-sa-mono np-sa-dim np-sa-small">{event.action}</span> : null}
        </span>
      </td>
      <td data-label="Quién">{event.actorEmail ?? 'El sistema'}</td>
      <td data-label="Local">{event.venue?.name ?? 'General'}</td>
      <td data-label="Motivo">{reason ?? '—'}</td>
      <td data-label="" data-card="actions">
        <div className="np-sa-cell-stack np-sa-grow">
          <SmallButton onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? 'Ocultar datos' : 'Ver datos'}
          </SmallButton>
          {open ? <AuditDetails event={event} /> : null}
        </div>
      </td>
    </tr>
  );
}

function AuditDetails({ event }: { event: AuditEventView }) {
  const target = event.targetType ? `${event.targetType}${event.targetId ? ` · ${event.targetId}` : ''}` : null;
  return (
    <div className="np-sa-audit-details">
      {target ? <span>Sobre: {target}</span> : null}
      {event.ip ? <span>IP: {event.ip}</span> : null}
      {event.payload !== null && event.payload !== undefined ? (
        <pre className="np-sa-pre">{JSON.stringify(event.payload, null, 2)}</pre>
      ) : null}
    </div>
  );
}
