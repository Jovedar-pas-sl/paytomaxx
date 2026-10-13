'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input } from '@nightpay/ui';
import {
  fetchBankStatement,
  fetchBankStatements,
  importBankStatement,
  type BankItemStatus,
  type BankSource,
  type BankStatementItem,
  type BankStatementSummary,
} from '@/lib/api';

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
 * y se compara con lo apuntado. Lo que no cuadra también sale en Incidencias.
 */
export function BankReconPanel({ isOwner }: { isOwner: boolean }) {
  const [statements, setStatements] = useState<BankStatementSummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      setStatements(await fetchBankStatements());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
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
      {error ? <p style={errorStyle}>{error}</p> : null}
      {openId ? <StatementDetail id={openId} onClose={() => setOpenId(null)} /> : null}
      <Card style={{ padding: '1rem' }}>
        <h3 style={sectionTitle}>Cuadres anteriores</h3>
        {statements.length === 0 ? (
          <p style={mutedStyle}>Todavía no has subido ningún fichero del banco.</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={theadRow}>
                <th style={th}>Días</th>
                <th style={th}>Banco</th>
                <th style={thRight}>Operaciones</th>
                <th style={thRight}>Diferencias</th>
                <th style={thRight}>Banco / aquí</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {statements.map((s) => (
                <tr key={s.id} style={{ ...trStyle, opacity: s.superseded ? 0.5 : 1 }}>
                  <td style={td}>{period(s)}</td>
                  <td style={td}>{s.source === 'REDSYS' ? 'TPV virtual' : 'Datáfonos'}</td>
                  <td style={tdRight}>{s.rowsTotal}</td>
                  <td style={{ ...tdRight, color: clean(s) ? 'var(--np-success)' : 'var(--np-danger)' }}>
                    {clean(s) ? 'Cuadra' : s.problemCount + s.skippedCount + s.otherCount}
                  </td>
                  <td style={tdRight}>
                    <span className="np-num">
                      {eur(s.bankTotalCents)} / {eur(s.oursTotalCents)}
                    </span>
                  </td>
                  <td style={td}>
                    <Button variant="ghost" onClick={() => setOpenId(s.id)}>
                      Ver
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
  const current = SOURCES.find((s) => s.value === source)!;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
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
      setFile(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ padding: '1.25rem' }}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
        <div>
          <h3 style={sectionTitle}>Cuadre con el banco</h3>
          <p style={mutedStyle}>
            Sube lo que el banco dice que cobró y se compara con lo apuntado aquí, cobro a cobro. Lo que no cuadra sale
            abajo y en Incidencias. Hazlo cada mañana con el día anterior.
          </p>
        </div>
        <div role="radiogroup" aria-label="De dónde es el fichero" style={sourceRow}>
          {SOURCES.map((s) => (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={source === s.value}
              onClick={() => setSource(s.value)}
              style={{ ...sourceBtn, borderColor: source === s.value ? 'var(--np-accent)' : 'var(--np-border)' }}
            >
              {s.title}
            </button>
          ))}
        </div>
        <p style={mutedStyle}>{current.how}</p>
        <input
          type="file"
          accept=".csv,.txt,.xls,.htm,.html"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          aria-label="Fichero del banco"
        />
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.85rem' }}>
          <input type="checkbox" checked={withDays} onChange={(e) => setWithDays(e.target.checked)} />
          El fichero no trae fechas (indicar los días)
        </label>
        {withDays ? (
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <Input label="Desde" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <Input label="Hasta" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        ) : null}
        {error ? <p style={errorStyle}>{error}</p> : null}
        <Button type="submit" loading={busy} disabled={!file || (withDays && (!from || !to))}>
          Cuadrar
        </Button>
      </form>
    </Card>
  );
}

function StatementDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<{ statement: BankStatementSummary; items: BankStatementItem[] } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    fetchBankStatement(id)
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [id]);

  if (error) return <p style={errorStyle}>{error}</p>;
  if (!data) return <p style={mutedStyle}>Cargando el cuadre…</p>;
  const { statement, items } = data;
  const visible = showAll ? items : items.filter((i) => STATUS[i.status].tone !== 'ok');

  return (
    <Card style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start' }}>
        <div>
          <h3 style={sectionTitle}>
            {statement.source === 'REDSYS' ? 'TPV virtual' : 'Datáfonos'} · {period(statement)}
          </h3>
          <p style={mutedStyle}>
            {statement.rowsTotal} operaciones en el fichero · {statement.matchedCount} cuadran ·{' '}
            <strong style={{ color: clean(statement) ? 'var(--np-success)' : 'var(--np-danger)' }}>
              {statement.problemCount > 0 ? `${statement.problemCount} diferencias` : clean(statement) ? 'todo cuadra' : 'sin diferencias en lo leído'}
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
            Neto banco <strong className="np-num">{eur(statement.bankTotalCents)}</strong> · neto aquí{' '}
            <strong className="np-num">{eur(statement.oursTotalCents)}</strong>
            {statement.superseded ? ' · sustituido por un fichero posterior' : ''}
          </p>
        </div>
        <Button variant="ghost" onClick={onClose}>
          Cerrar
        </Button>
      </div>
      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.85rem' }}>
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
        Ver también lo que cuadra
      </label>
      {visible.length === 0 ? (
        <p style={{ ...mutedStyle, color: 'var(--np-success)' }}>No hay diferencias.</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={theadRow}>
              <th style={th}>Estado</th>
              <th style={th}>Hora</th>
              <th style={thRight}>Banco</th>
              <th style={thRight}>Aquí</th>
              <th style={th}>Referencia</th>
              <th style={th}>Local</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((i) => (
              <tr key={i.id} style={{ ...trStyle, opacity: i.superseded ? 0.5 : 1 }}>
                <td style={{ ...td, color: toneColor(STATUS[i.status].tone), fontWeight: 600 }}>
                  {STATUS[i.status].label}
                </td>
                <td style={td}>{i.occurredAt ? when(i.occurredAt) : '—'}</td>
                <td style={tdRight}>{i.bankAmountCents !== null ? eur(sign(i) * i.bankAmountCents) : '—'}</td>
                <td style={tdRight}>{i.oursAmountCents !== null ? eur(sign(i) * i.oursAmountCents) : '—'}</td>
                <td style={td}>
                  <span className="np-num">{i.reference ?? '—'}</span>
                  {i.authCode ? <span style={mutedInline}> · aut. {i.authCode}</span> : null}
                </td>
                <td style={td}>{i.venueName ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
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

function when(iso: string): string {
  return new Date(iso).toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function eur(cents: number): string {
  return `${(cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

const sectionTitle: CSSProperties = { margin: 0, fontSize: '0.95rem', fontWeight: 600 };
const mutedStyle: CSSProperties = { margin: '0.25rem 0 0', fontSize: '0.82rem', color: 'var(--np-text-mute)' };
const mutedInline: CSSProperties = { fontSize: '0.75rem', color: 'var(--np-text-mute)' };
const errorStyle: CSSProperties = { margin: 0, fontSize: '0.85rem', color: 'var(--np-danger)' };
const sourceRow: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' };
const sourceBtn: CSSProperties = {
  padding: '0.75rem',
  background: 'var(--np-surface-2)',
  border: '2px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  color: 'var(--np-text)',
  fontFamily: 'inherit',
  fontWeight: 600,
  cursor: 'pointer',
  textAlign: 'left',
};
const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' };
const theadRow: CSSProperties = { borderBottom: '1px solid var(--np-border)', color: 'var(--np-text-mute)' };
const th: CSSProperties = {
  padding: '0.5rem 0.6rem',
  textAlign: 'left',
  fontSize: '0.72rem',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  fontWeight: 500,
};
const thRight: CSSProperties = { ...th, textAlign: 'right' };
const trStyle: CSSProperties = { borderBottom: '1px solid var(--np-border)' };
const td: CSSProperties = { padding: '0.55rem 0.6rem' };
const tdRight: CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
