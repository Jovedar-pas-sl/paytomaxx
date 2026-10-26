import type { ChicaSummary, ExportSummary, TypeLine } from '../reports/export-csv';

/**
 * Qué resume el aviso de las 9:00 (DIN-4). Si esa noche se cerró (a mano o
 * sola a las 08:00), su Z congelado: lo mismo que el panel → Noches, aunque
 * algo se apunte después (va al Z siguiente, como ajuste). Si no hay ninguna
 * cerrada en el tramo, lo apuntado de las 08:00 de ayer a las 08:00 de hoy, y
 * el aviso dice que no es un Z.
 */
export type SummaryScope =
  | { kind: 'nights'; nights: ReadonlyArray<{ closedAt: Date; autoClosed: boolean }> }
  | { kind: 'window' };

const MADRID_TIME = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const at = (d: Date): string => `a las ${MADRID_TIME.format(d)}`;

/** «anoche: el Z de la noche cerrada a las 05:00» y demás (sin el local). */
export function scopeLabel(scope: SummaryScope): string {
  if (scope.kind === 'window' || scope.nights.length === 0) {
    return 'anoche: de las 08:00 de ayer a las 08:00 de hoy (sin noche cerrada)';
  }
  if (scope.nights.length === 1) {
    const n = scope.nights[0]!;
    return n.autoClosed ? `anoche: el Z de la noche, cerrada sola ${at(n.closedAt)}` : `anoche: el Z de la noche cerrada ${at(n.closedAt)}`;
  }
  const times = scope.nights.map((n) => at(n.closedAt).replace(/^a las /, ''));
  const list = `${times.slice(0, -1).join(', ')} y a las ${times.at(-1)!}`;
  return `anoche: los Z de ${scope.nights.length} noches cerradas (a las ${list})`;
}

/** Suma por clave (label o name), en el orden en que aparecen. */
function mergeBy<T extends object>(lists: ReadonlyArray<ReadonlyArray<T>>, key: (t: T) => string): T[] {
  const out = new Map<string, T>();
  for (const list of lists) {
    for (const item of list) {
      const k = key(item);
      const prev = out.get(k);
      out.set(k, prev ? (sumObjects([prev, item]) as T) : item);
    }
  }
  return [...out.values()];
}

/** Campos numéricos sumados; uno que falta en alguno (un Z antiguo) queda sin poner. */
function sumObjects(items: ReadonlyArray<object>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...items[0] };
  const keys = new Set(items.flatMap((i) => Object.keys(i)));
  for (const k of keys) {
    const values = items.map((i) => (i as Record<string, unknown>)[k]);
    if (values.every((v) => typeof v === 'number')) out[k] = (values as number[]).reduce((a, b) => a + b, 0);
    else if (values.some((v) => typeof v === 'number') && values.some((v) => v === undefined)) delete out[k];
  }
  return out;
}

/**
 * Los Z de varias noches cerradas en el mismo tramo (p. ej. se cerró, se
 * volvió a abrir y se cerró otra vez): un solo resumen con todo sumado.
 */
export function mergeSummaries(list: ReadonlyArray<ExportSummary>): ExportSummary {
  if (list.length === 1) return list[0]!;
  const merged = sumObjects(list) as unknown as ExportSummary;
  return {
    ...merged,
    byType: mergeBy<TypeLine>(list.map((s) => s.byType ?? []), (t) => t.label),
    saldoByType: mergeBy<TypeLine>(list.map((s) => s.saldoByType ?? []), (t) => t.label),
    perChica: mergeBy<ChicaSummary>(list.map((s) => s.perChica ?? []), (c) => c.name),
  };
}
