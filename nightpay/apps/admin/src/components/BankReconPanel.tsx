'use client';

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Checkbox, Input } from '@nightpay/ui';
import {
  fetchBankStatement,
  fetchBankStatements,
  importBankStatement,
  type BankItemStatus,
  type BankSource,
  type BankStatementItem,
  type BankStatementSummary,
} from '@/lib/api';
import { formatDateTime, isValidRange } from '@/lib/dates';
import { formatEur } from '@/lib/money';
import { useVenueTimezone } from '@/lib/venue-context';
import { Notice } from './Notice';

const SOURCES: Array<{ value: BankSource; title: string; how: string }> = [
  {
    value: 'REDSYS',
    title: 'BBVA · TPV virtual (QR)',
    how: 'En canales.redsys.es: Consultas → Buscar (elige los días, máximo 31) → «Exportar tabla». Sube ese fichero.',
  },
  {
    value: 'PAYTEF',
    title: 'Paytef · datáfonos',
    how: 'En my.paytef.es: operaciones de los días que quieras cuadrar, exportadas en CSV.',
  },
];

const STATUS: Record<BankItemStatus, { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  MATCHED: { label: 'Cuadra', tone: 'ok' },
  REFUND_MATCHED: { label: 'Devolución cuadra', tone: 'ok' },
  AMOUNT_MISMATCH: { label: 'Importe distinto', tone: 'bad' },
  NOT_PAID_HERE: { label: 'Cobrado en el banco, aquí sin pagar', tone: 'bad' },
  NOT_IN_OXIOPAY: { label: 'Solo en el banco', tone: 'warn' },
  NOT_IN_BANK: { label: 'Falta en el banco', tone: 'bad' },
  REFUND_NOT_IN_OXIOPAY: { label: 'Devolución sin apuntar', tone: 'warn' },
  REFUND_NOT_IN_BANK: { label: 'Devolución que el banco no tiene', tone: 'bad' },
};

/**
 * Cuadre con el banco: el dueño sube el fichero de operaciones del portal
 * y se compara con lo apuntado. Lo que no cuadra también sale en Avisos.
 */
export function BankReconPanel({ isOwner }: { isOwner: boolean }) {
  /** null = cargando (antes salía "no has subido nada" mientras cargaba). */
  const [statements, setStatements] = useState<BankStatementSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function reload() {
    setLoadError(null);
    try {
      setStatements(await fetchBankStatements());
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }

  useEffect(() => {
    if (isOwner) void reload();
  }, [isOwner]);

  if (!isOwner) {
    return (
      <Card style={{ padding: '1.25rem' }}>
        <p style={{ margin: 0 }}>El cuadre con el banco lo hace el dueño.</p>
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <UploadCard
        onDone={(s) => {
          void reload();
          setOpenId(s.id);
        }}
      />
      {openId ? <StatementDetail id={openId} onClose={() => setOpenId(null)} /> : null}
      <Card className="np-table-host" style={{ padding: '1rem' }} data-tour="banco-anteriores">
        <h3 style={sectionTitle}>Cuadres anteriores</h3>
        {loadError ? (
          <Notice tone="danger" action={{ label: 'Reintentar', onClick: () => void reload() }} style={{ marginTop: '0.5rem' }}>
            No se pudieron cargar los cuadres: {loadError}
          </Notice>
        ) : statements === null ? (
          <p style={mutedStyle}>Cargando…</p>
        ) : statements.length === 0 ? (
          <p style={mutedStyle}>Todavía no has subido ningún fichero del banco.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="np-table">
              <thead>
                <tr>
                  <th>Días</th>
                  <th>Banco</th>
                  <th style={alignRight}>Operaciones</th>
                  <th style={alignRight}>Diferencias</th>
                  <th style={alignRight}>Banco / aquí</th>
                  <th aria-label="Acciones" />
                </tr>
              </thead>
              <tbody>
                {statements.map((s) => (
                  <tr key={s.id} style={{ opacity: s.superseded ? 0.5 : 1 }}>
                    <td data-label="Días" data-card="title">
                      {period(s)}
                    </td>
                    <td data-label="Banco" data-card="top">
                      {s.source === 'REDSYS' ? 'TPV virtual' : 'Datáfonos'}
                    </td>
                    <td data-label="Operaciones" style={numTd}>
                      {s.rowsTotal}
                    </td>
                    <td
                      data-label="Diferencias"
                      style={{ ...numTd, color: clean(s) ? 'var(--np-success)' : 'var(--np-danger)' }}
                    >
                      {clean(s) ? 'Cuadra' : s.problemCount + s.skippedCount + s.otherCount}
                    </td>
                    <td data-label="Banco / aquí" style={numTd}>
                      <span className="np-num">
                        {formatEur(s.bankTotalCents)} / {formatEur(s.oursTotalCents)}
                      </span>
                    </td>
                    <td data-label="Acciones" data-card="actions">
                      <Button variant="ghost" onClick={() => setOpenId(s.id)}>
                        Ver
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function UploadCard({ onDone }: { onDone: (s: BankStatementSummary) => void }) {
  const [source, setSource] = useState<BankSource>('REDSYS');
  const [file, setFile] = useState<File | null>(null);
  const [withDays, setWithDays] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const current = SOURCES.find((s) => s.value === source) ?? SOURCES[0]!;
  const badRange = withDays && Boolean(from) && Boolean(to) && !isValidRange(from, to);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    if (withDays && !isValidRange(from, to)) {
      setError('El último día no puede ser anterior al primero.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onDone(
        await importBankStatement({
          source,
          file,
          ...(withDays && from && to ? { periodFrom: from, periodTo: to } : {}),
        }),
      );
      // El fichero ya está cuadrado: el campo se vacía de verdad (no solo el estado).
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ padding: '1.25rem' }} data-tour="banco-cuadre">
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
        <div>
          <h3 style={sectionTitle}>Cuadre con el banco</h3>
          <p style={mutedStyle}>
            Sube lo que el banco dice que cobró y se compara con lo apuntado aquí, cobro a cobro. Lo que no cuadra sale
            abajo y en Avisos. Hazlo cada mañana con el día anterior.
          </p>
        </div>
        <div role="radiogroup" aria-label="De dónde es el fichero" style={sourceRow} data-tour="banco-origen">
          {SOURCES.map((s) => (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={source === s.value}
              onClick={() => setSource(s.value)}
              style={{
                ...sourceBtn,
                // Lo elegido en t1 (la lima es para «Subir»).
                borderColor: source === s.value ? 'var(--np-text)' : 'var(--np-border-hi)',
                boxShadow: source === s.value ? 'inset 0 0 0 1px var(--np-text)' : undefined,
              }}
            >
              {s.title}
            </button>
          ))}
        </div>
        <p style={mutedStyle}>{current.how}</p>
        <label className="np-file">
          <span>Fichero del banco</span>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.txt,.xls,.htm,.html"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <Checkbox label="El fichero no trae fechas (indicar los días)" checked={withDays} onChange={setWithDays} />
        {withDays ? (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 10rem' }}>
              <Input label="Desde" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div style={{ flex: '1 1 10rem' }}>
              <Input
                label="Hasta"
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
                error={badRange ? 'No puede ser anterior a «Desde».' : undefined}
              />
            </div>
          </div>
        ) : null}
        {error ? (
          <p role="alert" style={errorStyle}>
            {error}
          </p>
        ) : null}
        <Button type="submit" loading={busy} disabled={!file || (withDays && (!from || !to || badRange))} data-tour="banco-subir">
          Cuadrar
        </Button>
      </form>
    </Card>
  );
}

function StatementDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const tz = useVenueTimezone();
  const [data, setData] = useState<{ statement: BankStatementSummary; items: BankStatementItem[] } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Otro cuadre (o reintento): fuera lo anterior, también el error, y una
    // respuesta que llegue tarde de otro id no pisa esta.
    let cancelled = false;
    setData(null);
    setError(null);
    fetchBankStatement(id)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  if (error) {
    return (
      <Notice tone="danger" action={{ label: 'Reintentar', onClick: () => setAttempt((n) => n + 1) }}>
        No se pudo abrir el cuadre: {error}
      </Notice>
    );
  }
  if (!data) return <p style={mutedStyle}>Cargando el cuadre…</p>;
  const { statement, items } = data;
  const visible = showAll ? items : items.filter((i) => STATUS[i.status].tone !== 'ok');

  return (
    <Card className="np-table-host" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start' }}>
        <div>
          <h3 style={sectionTitle}>
            {statement.source === 'REDSYS' ? 'TPV virtual' : 'Datáfonos'} · {period(statement)}
          </h3>
          <p style={mutedStyle}>
            {statement.rowsTotal} operaciones en el fichero · {statement.matchedCount} cuadran ·{' '}
            <strong style={{ color: clean(statement) ? 'var(--np-success)' : 'var(--np-danger)' }}>
              {statement.problemCount > 0
                ? `${statement.problemCount} diferencias`
                : clean(statement)
                  ? 'todo cuadra'
                  : 'sin diferencias en lo leído'}
            </strong>
          </p>
          {statement.skippedCount > 0 ? (
            <p style={{ ...mutedStyle, color: 'var(--np-danger)' }}>
              {statement.skippedCount} operaciones del fichero no se pudieron leer: revísalas en el portal del banco.
            </p>
          ) : null}
          {statement.otherCount > 0 ? (
            <p style={{ ...mutedStyle, color: 'var(--np-warning)' }}>
              {statement.otherCount} operaciones de otro tipo (preautorizaciones…) no entran en el cuadre.
            </p>
          ) : null}
          <p style={mutedStyle}>
            Neto banco <strong className="np-num">{formatEur(statement.bankTotalCents)}</strong> · neto aquí{' '}
            <strong className="np-num">{formatEur(statement.oursTotalCents)}</strong>
            {statement.superseded ? ' · sustituido por un fichero posterior' : ''}
          </p>
        </div>
        <Button variant="ghost" onClick={onClose}>
          Cerrar
        </Button>
      </div>
      <Checkbox label="Ver también lo que cuadra" checked={showAll} onChange={setShowAll} />
      {visible.length === 0 ? (
        <p style={{ ...mutedStyle, color: 'var(--np-success)' }}>No hay diferencias.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="np-table">
            <thead>
              <tr>
                <th>Estado</th>
                <th>Hora</th>
                <th style={alignRight}>Banco</th>
                <th style={alignRight}>Aquí</th>
                <th>Referencia</th>
                <th>Local</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((i) => (
                <tr key={i.id} style={{ opacity: i.superseded ? 0.5 : 1 }}>
                  <td
                    data-label="Estado"
                    data-card="title"
                    style={{ color: toneColor(STATUS[i.status].tone), fontWeight: 600 }}
                  >
                    {STATUS[i.status].label}
                  </td>
                  <td data-label="Hora" data-card="top">
                    {i.occurredAt ? formatDateTime(i.occurredAt, tz, 'compact') : '—'}
                  </td>
                  <td data-label="Banco" data-card="amount" style={numTd}>
                    {i.bankAmountCents !== null ? formatEur(sign(i) * i.bankAmountCents) : '—'}
                  </td>
                  <td data-label="Aquí" style={numTd}>
                    {i.oursAmountCents !== null ? formatEur(sign(i) * i.oursAmountCents) : '—'}
                  </td>
                  <td data-label="Referencia">
                    <span className="np-num">{i.reference ?? '—'}</span>
                    {i.authCode ? <span style={mutedInline}> · aut. {i.authCode}</span> : null}
                  </td>
                  <td data-label="Local">{i.venueName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** Cuadra de verdad: sin diferencias y sin nada que no se haya podido comparar. */
function clean(s: BankStatementSummary): boolean {
  return s.problemCount === 0 && s.skippedCount === 0 && s.otherCount === 0;
}

function sign(i: BankStatementItem): number {
  return i.kind === 'REFUND' ? -1 : 1;
}

function toneColor(tone: 'ok' | 'warn' | 'bad'): string {
  return tone === 'ok' ? 'var(--np-success)' : tone === 'warn' ? 'var(--np-warning)' : 'var(--np-danger)';
}

function period(s: BankStatementSummary): string {
  const f = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  return s.periodFrom === s.periodTo ? f(s.periodFrom) : `${f(s.periodFrom)} – ${f(s.periodTo)}`;
}

const sectionTitle: CSSProperties = { margin: 0, fontSize: '1rem', fontWeight: 600 };
const mutedStyle: CSSProperties = { margin: '0.25rem 0 0', fontSize: '0.875rem', color: 'var(--np-text-mute)' };
const mutedInline: CSSProperties = { fontSize: '0.875rem', color: 'var(--np-text-mute)' };
const errorStyle: CSSProperties = { margin: 0, fontSize: '0.875rem', color: 'var(--np-danger)' };
const sourceRow: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))', gap: '0.5rem' };
const sourceBtn: CSSProperties = {
  padding: '0.75rem',
  background: 'var(--np-surface-2)',
  border: '1px solid var(--np-border-hi)',
  borderRadius: 'var(--np-r-sm)',
  color: 'var(--np-text)',
  fontFamily: 'inherit',
  fontWeight: 400,
  cursor: 'pointer',
  textAlign: 'left',
};
const alignRight: CSSProperties = { textAlign: 'right' };
const numTd: CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
