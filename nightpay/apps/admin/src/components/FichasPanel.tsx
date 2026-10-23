'use client';

import { useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input, Select } from '@nightpay/ui';
import {
  fetchFichas,
  fetchFichasSummary,
  markFicha,
  setFichaNumber,
  type FichasSummary,
  type WalletCardRow,
  type WalletCardStatus,
} from '@/lib/api';
import { formatDateTime } from '@/lib/dates';
import { keepIfSame } from '@/lib/diff';
import {
  FICHA_STATUS_FILTERS,
  FICHA_STATUS_TONE,
  fichaActions,
  fichaConfirmText,
  fichaNumberCell,
  fichaQuery,
  fichaSince,
  fichaStatusLabel,
  formatUid,
  nightLosesFichas,
  nightStockText,
  printedNumberInput,
} from '@/lib/fichas';
import { usePolling } from '@/lib/use-polling';
import { useVenueTimezone } from '@/lib/venue-context';
import { Notice } from './Notice';
import { Pill } from './Pill';

const POLL_MS = 20_000;

/**
 * Clientes → Fichas: cuántas hay en el stock y entregadas, lo de cada noche
 * (entregadas, devueltas, perdidas y el stock al cerrar) y la lista para
 * buscar una ficha por su número impreso, su número de serie o el código del
 * saldo, ponerle (o corregir) su número impreso, bloquearla o marcarla
 * perdida. Las fichas se preparan en el datáfono o en un Android.
 */
export function FichasPanel() {
  const tz = useVenueTimezone();
  const [summary, setSummary] = useState<FichasSummary | null>(null);
  const [rows, setRows] = useState<WalletCardRow[] | null>(null);
  const [status, setStatus] = useState<WalletCardStatus | ''>('');
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** La ficha a la que se le está poniendo el número impreso, y lo tecleado. */
  const [numbering, setNumbering] = useState<{ id: string; draft: string } | null>(null);

  const reload = usePolling(
    async (signal) => {
      try {
        const [s, list] = await Promise.all([fetchFichasSummary(), fetchFichas({ q: query, status })]);
        if (signal.aborted) return true;
        setSummary((prev) => keepIfSame(prev, s));
        setRows((prev) => keepIfSame(prev, list));
        setError(null);
        return true;
      } catch (err) {
        if (!signal.aborted) setError((err as Error).message);
        return false;
      }
    },
    { intervalMs: POLL_MS },
    [query, status],
  );

  function search(e: FormEvent): void {
    e.preventDefault();
    setRows(null);
    setQuery(fichaQuery(draft));
  }

  async function mark(row: WalletCardRow, action: 'block' | 'lost'): Promise<void> {
    if (!window.confirm(fichaConfirmText(row, action))) return;
    setBusy(row.id);
    setActionError(null);
    try {
      const next = await markFicha(row.id, action);
      setRows((prev) => (prev ? prev.map((r) => (r.id === next.id ? next : r)) : prev));
      reload();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function saveNumber(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!numbering) return;
    const printed = printedNumberInput(numbering.draft);
    if (!printed) return setActionError('El número impreso son de 1 a 12 cifras, tal como aparecen en la ficha.');
    setBusy(numbering.id);
    setActionError(null);
    try {
      const next = await setFichaNumber(numbering.id, printed);
      setRows((prev) => (prev ? prev.map((r) => (r.id === next.id ? next : r)) : prev));
      setNumbering(null);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {error ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: reload }}>
          {error}
          {summary ? ' · se siguen enseñando los últimos datos.' : ''}
        </Notice>
      ) : null}
      {actionError ? <Notice tone="danger">{actionError}</Notice> : null}

      {summary ? (
        <section style={tilesGrid}>
          <Tile title="En stock" value={String(summary.enStock)} subtitle="Grabadas y sin dar (también las devueltas)" />
          <Tile title="Entregadas" value={String(summary.entregadas)} subtitle="Ahora mismo en manos de clientes" />
        </section>
      ) : null}

      <Card className="np-table-host" style={{ padding: '1rem' }}>
        <h3 style={sectionTitle}>Por noche</h3>
        {!summary ? (
          <p style={mutedText}>{error ? 'No se pudo cargar.' : 'Cargando…'}</p>
        ) : summary.nights.length === 0 ? (
          <p style={mutedText}>Aún no hay noches. Las fichas se cuentan desde que se abre la noche.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="np-table">
              <thead>
                <tr>
                  <th>Noche</th>
                  <th style={alignRight}>Entregadas</th>
                  <th style={alignRight}>Devueltas</th>
                  <th style={alignRight}>Perdidas</th>
                  <th style={alignRight}>En stock</th>
                </tr>
              </thead>
              <tbody>
                {summary.nights.map((n) => (
                  <tr key={n.nightId}>
                    <td data-label="Noche" data-card="title">
                      {formatDateTime(n.from, tz, 'short')}
                      {n.open ? (
                        <Pill tone="success" style={{ marginLeft: '0.4rem' }}>
                          Abierta
                        </Pill>
                      ) : null}
                    </td>
                    <td data-label="Entregadas" style={numTd}>
                      {n.entregadas}
                    </td>
                    <td data-label="Devueltas" style={numTd}>
                      {n.devueltas}
                    </td>
                    <td data-label="Perdidas" style={numTd}>
                      {nightLosesFichas(n) ? <Pill tone="warning">{n.perdidas}</Pill> : n.perdidas}
                    </td>
                    <td data-label="En stock" style={numTd}>
                      {nightStockText(n)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="np-table-host" style={{ padding: '1rem' }}>
        <div style={listHeader}>
          <h3 style={sectionTitle}>Fichas</h3>
          <form onSubmit={search} style={searchRow}>
            <Input
              aria-label="Buscar ficha"
              placeholder="Número impreso, serie o código"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              style={{ width: '16rem' }}
            />
            <Button type="submit" variant="ghost">
              Buscar
            </Button>
            <Select
              aria-label="Filtrar por estado"
              value={status}
              onChange={(e) => {
                setRows(null);
                setStatus(e.target.value as WalletCardStatus | '');
              }}
              style={{ width: '10rem' }}
            >
              {FICHA_STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </Select>
          </form>
        </div>

        {rows === null ? (
          <p style={mutedText}>{error ? 'No se pudo cargar la lista.' : 'Cargando…'}</p>
        ) : rows.length === 0 ? (
          <p style={mutedText}>
            {query ? 'Ninguna ficha con eso.' : 'Sin fichas. Se preparan en el datáfono o en un Android: «Preparar fichas».'}
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="np-table">
              <thead>
                <tr>
                  <th>Número de ficha</th>
                  <th>Serie (UID)</th>
                  <th>Estado</th>
                  <th>Saldo</th>
                  <th>Desde</th>
                  <th>Último uso</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const actions = fichaActions(r);
                  const since = fichaSince(r);
                  const num = fichaNumberCell(r);
                  const editing = numbering?.id === r.id;
                  return (
                    <tr key={r.id}>
                      <td data-label="Número de ficha" data-card="title">
                        {editing ? (
                          <form onSubmit={(e) => void saveNumber(e)} style={numberForm}>
                            <Input
                              aria-label="Número impreso en la ficha"
                              inputMode="numeric"
                              autoFocus
                              maxLength={12}
                              value={numbering.draft}
                              onChange={(e) => setNumbering({ id: r.id, draft: e.target.value.replace(/\D/g, '').slice(0, 12) })}
                              style={{ width: '9rem' }}
                            />
                            <Button type="submit" disabled={busy !== null}>Guardar</Button>
                            <Button type="button" variant="ghost" onClick={() => setNumbering(null)}>Cancelar</Button>
                          </form>
                        ) : num.missing ? (
                          <span style={hintText}>{num.text}</span>
                        ) : (
                          <span className="np-num" style={{ fontWeight: 600 }}>
                            {num.text}
                          </span>
                        )}
                        {num.repeated && !editing ? (
                          <Pill tone="warning" style={{ marginLeft: '0.4rem' }}>
                            Repetido: cámbialo
                          </Pill>
                        ) : null}
                      </td>
                      <td data-label="Serie (UID)">
                        <span className="np-num">{formatUid(r.uid)}</span>
                        <span style={hintText}> · {r.tokenHint}…</span>
                      </td>
                      <td data-label="Estado">
                        <Pill tone={FICHA_STATUS_TONE[r.status]}>{fichaStatusLabel(r.status)}</Pill>
                      </td>
                      <td data-label="Saldo">
                        <span className="np-num">{r.walletCode ?? '—'}</span>
                      </td>
                      <td data-label="Desde" data-card="top">
                        {since ? formatDateTime(since, tz, 'short') : '—'}
                      </td>
                      <td data-label="Último uso">{r.lastUsedAt ? formatDateTime(r.lastUsedAt, tz, 'short') : '—'}</td>
                      <td data-label="Acciones" data-card="actions">
                        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                          {!editing ? (
                            <Button variant="ghost" disabled={busy !== null} onClick={() => setNumbering({ id: r.id, draft: r.printedNumber ?? '' })}>
                              {num.missing ? 'Poner número' : 'Cambiar número'}
                            </Button>
                          ) : null}
                          {actions.lost ? (
                            <Button variant="ghost" disabled={busy !== null} onClick={() => void mark(r, 'lost')}>
                              Marcar perdida
                            </Button>
                          ) : null}
                          {actions.block ? (
                            <Button variant="ghost" disabled={busy !== null} onClick={() => void mark(r, 'block')}>
                              Bloquear
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Tile({ title, value, subtitle }: { title: string; value: string; subtitle?: string }) {
  return (
    <Card style={{ padding: '1rem' }}>
      <p style={kicker}>{title}</p>
      <p className="np-num" style={tileNumber}>
        {value}
      </p>
      {subtitle ? <p style={tileSub}>{subtitle}</p> : null}
    </Card>
  );
}

const tilesGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))',
  gap: '0.75rem',
};

const sectionTitle: CSSProperties = { margin: '0 0 0.75rem', fontSize: '0.9rem', fontWeight: 600, letterSpacing: '-0.01em' };

const listHeader: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '0.75rem',
  flexWrap: 'wrap',
  marginBottom: '0.75rem',
};

const searchRow: CSSProperties = { display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' };

const alignRight: CSSProperties = { textAlign: 'right' };
const numTd: CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

const kicker: CSSProperties = {
  margin: 0,
  fontSize: '0.7rem',
  color: 'var(--np-text-dim)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 500,
};

const tileNumber: CSSProperties = {
  margin: '0.3rem 0 0',
  fontSize: '1.4rem',
  // Cifra grande del panel: Manrope 800, como los importes (las de las tablas, 700).
  fontWeight: 800,
  letterSpacing: '-0.02em',
  fontVariantNumeric: 'tabular-nums',
};

const tileSub: CSSProperties = { margin: '0.2rem 0 0', fontSize: '0.75rem', color: 'var(--np-text-mute)' };
const mutedText: CSSProperties = { margin: 0, fontSize: '0.85rem', color: 'var(--np-text-dim)' };
const hintText: CSSProperties = { fontSize: '0.75rem', color: 'var(--np-text-dim)' };
const numberForm: CSSProperties = { display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' };
