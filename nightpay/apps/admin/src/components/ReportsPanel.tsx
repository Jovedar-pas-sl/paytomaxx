'use client';

import { useState, type CSSProperties } from 'react';
import { Button, Card, Input } from '@nightpay/ui';
import { downloadExport, type ExportKind } from '@/lib/api';
import { isValidRange, lastDayOfMonth, presetRange, type ReportPreset } from '@/lib/dates';
import { FILTER_FIELD } from '@/lib/filter-field';

const REPORTS: Array<{ kind: ExportKind; title: string; detail: string }> = [
  {
    kind: 'resumen',
    title: 'Resumen para la gestoría',
    detail: 'Totales del periodo, reparto entre chicas y local, devoluciones y lo pagado a cada chica.',
  },
  {
    kind: 'cobros',
    title: 'Libro de cobros',
    detail: 'Un cobro por línea: importe, propina, método, tarjeta, autorización del banco y reparto.',
  },
  {
    kind: 'devoluciones',
    title: 'Devoluciones',
    detail: 'Las devoluciones del periodo y lo descontado a cada chica.',
  },
  {
    kind: 'liquidaciones',
    title: 'Pagos a chicas',
    detail: 'Cada pago hecho a una chica: importe, vía y referencia.',
  },
  {
    kind: 'recargas-efectivo',
    title: 'Recargas en efectivo',
    detail: 'Cada recarga del saldo en efectivo, con quién la cobró; las anulaciones van en negativo.',
  },
  {
    kind: 'saldo-devuelto',
    title: 'Saldo devuelto',
    detail: 'El saldo devuelto a los clientes, en efectivo y a la tarjeta, con su referencia.',
  },
];

const PRESETS: Array<{ key: ReportPreset; label: string }> = [
  { key: 'lastMonth', label: 'Mes pasado' },
  { key: 'thisMonth', label: 'Este mes' },
  { key: 'lastQuarter', label: 'Trimestre pasado' },
  { key: 'thisYear', label: 'Este año' },
];

/**
 * Informes para la gestoría (Fase 1C). CSV que Excel abre con doble clic
 * (separador ";", decimales con coma). Solo el dueño.
 */
export function ReportsPanel({ isOwner }: { isOwner: boolean }) {
  // Días de Madrid, como el API: a las 00:30 del día 1 ya es "este mes" aunque
  // el navegador esté en otra zona.
  const [initial] = useState(() => presetRange('lastMonth', new Date()));
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isOwner) {
    return (
      <Card style={{ padding: '1.25rem' }}>
        <p style={{ margin: 0 }}>Los informes para la gestoría solo los descarga el dueño.</p>
      </Card>
    );
  }

  function applyPreset(p: ReportPreset) {
    const r = presetRange(p, new Date());
    setFrom(r.from);
    setTo(r.to);
    setError(null);
  }

  async function download(kind: ExportKind) {
    setError(null);
    if (!isValidRange(from, to)) {
      setError('Elige un periodo: la fecha final no puede ser anterior a la inicial.');
      return;
    }
    setBusy(kind);
    try {
      const blob = await downloadExport(kind, from, to);
      saveBlob(blob, `${kind}-${fileSlug(from, to)}.csv`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div>
        <h2 style={titleStyle}>Informes para la gestoría</h2>
        <p style={hintStyle}>
          Archivos que Excel abre con doble clic. Las fechas son en hora de Madrid, con los dos días incluidos.
        </p>
      </div>

      <Card style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          {PRESETS.map((p) => (
            <Button key={p.key} variant="ghost" size="sm" onClick={() => applyPreset(p.key)}>
              {p.label}
            </Button>
          ))}
        </div>
        <div style={dateGrid}>
          <Input label="Desde" type="date" style={FILTER_FIELD} value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input label="Hasta" type="date" style={FILTER_FIELD} value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </Card>

      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: 0 }}>
          {error}
        </p>
      ) : null}

      <div style={reportGrid}>
        {REPORTS.map((r) => (
          <Card key={r.kind} style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ flex: 1 }}>
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>{r.title}</h3>
              <p style={hintStyle}>{r.detail}</p>
            </div>
            <Button
              variant={r.kind === 'resumen' ? 'primary' : 'ghost'}
              loading={busy === r.kind}
              disabled={busy !== null && busy !== r.kind}
              onClick={() => void download(r.kind)}
            >
              Descargar
            </Button>
          </Card>
        ))}
      </div>
    </section>
  );
}

/** "2026-10" si es un mes entero; si no, las dos fechas. Igual que el servidor. */
function fileSlug(from: string, to: string): string {
  const wholeMonth = from.slice(0, 7) === to.slice(0, 7) && from.endsWith('-01') && to === lastDayOfMonth(to);
  return wholeMonth ? from.slice(0, 7) : `${from}_${to}`;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const titleStyle: CSSProperties = { margin: 0, fontSize: 'var(--np-t-h3)', fontWeight: 600 };
const hintStyle: CSSProperties = { margin: '0.25rem 0 0', color: 'var(--np-text-mute)', fontSize: '1rem' };
const dateGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))',
  gap: '0.75rem',
};
const reportGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(15rem, 1fr))',
  gap: '0.75rem',
};
