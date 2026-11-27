'use client';

import { useState, type CSSProperties } from 'react';
import { Button, Card, FormError } from '@nightpay/ui';
import { downloadExport, type ExportKind } from '@/lib/api';
import { isValidRange, lastDayOfMonth } from '@/lib/dates';
import { lineaPeriodo, PERIODOS_INFORMES, resolverPeriodo, type Periodo } from '@/lib/periodos';
import { SelectorNoches } from './SelectorNoches';

/** `partners`: solo con la API de socios (Ajustes → «Otras plataformas» contesta). */
const REPORTS: Array<{ kind: ExportKind; title: string; detail: string; partners?: true }> = [
  {
    kind: 'resumen',
    title: 'Resumen para la gestoría',
    detail: 'Totales del periodo, reparto entre compañeras y local, devoluciones y lo pagado a cada compañera.',
  },
  {
    kind: 'cobros',
    title: 'Libro de cobros',
    detail: 'Un cobro por línea: importe, propina, método, tarjeta, autorización del banco y reparto.',
  },
  {
    kind: 'devoluciones',
    title: 'Devoluciones',
    detail: 'Las devoluciones del periodo y lo descontado a cada compañera.',
  },
  {
    kind: 'liquidaciones',
    title: 'Pagos a compañeras',
    detail: 'Cada pago hecho a una compañera: importe, vía y referencia.',
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
  {
    kind: 'recargas-socios',
    title: 'Cargas de otras plataformas',
    detail: 'Cada carga de los cajeros de otras plataformas y cada anulación, en negativo, con su cajero.',
    partners: true,
  },
];

/**
 * Informes para la gestoría (Fase 1C). CSV que Excel abre con doble clic
 * (separador ";", decimales con coma). Solo el dueño.
 */
export function ReportsPanel({ isOwner, partnersOn = false }: { isOwner: boolean; partnersOn?: boolean }) {
  // Días de Madrid, como el API: a las 00:30 del día 1 ya es "este mes" aunque
  // el navegador esté en otra zona. Empieza en Mes pasado; no va a la URL.
  const [periodo, setPeriodo] = useState<Periodo>({ clave: 'mes-pasado' });
  const resolved = resolverPeriodo(periodo, [], new Date());
  const { from, to } = resolved.tipo === 'dias' ? { from: resolved.desde, to: resolved.hasta } : { from: '', to: '' };
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isOwner) {
    return (
      <Card style={{ padding: '1.25rem' }}>
        <p style={{ margin: 0 }}>Los informes para la gestoría solo los descarga el dueño.</p>
      </Card>
    );
  }

  function changePeriodo(next: Periodo) {
    setPeriodo(next);
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
        <SelectorNoches
          value={periodo}
          onChange={changePeriodo}
          opciones={PERIODOS_INFORMES}
          nights={null}
          linea={lineaPeriodo(resolved)}
          aplicar="Usar estas fechas"
        />
        <p style={{ ...hintStyle, marginTop: 0 }}>Los informes van por días naturales, como los pide la gestoría.</p>
      </Card>

      {error ? (
        <FormError>
          {error}
        </FormError>
      ) : null}

      <div style={reportGrid}>
        {REPORTS.filter((r) => !r.partners || partnersOn).map((r) => (
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
const reportGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(15rem, 1fr))',
  gap: '0.75rem',
};
