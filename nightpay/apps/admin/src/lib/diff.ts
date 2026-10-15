// "Guardar" solo manda lo que se cambió en el formulario: así no pisa lo que
// otra persona (o la chica desde su enlace) guardó mientras tanto.

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return stableStringify(a) === stableStringify(b);
}

/** Campos de `current` distintos de `initial` (objetos comparados por valor). */
export function changedFields<T extends object>(initial: T, current: T): Partial<T> {
  const keys = Object.keys(current) as Array<keyof T>;
  return keys.reduce<Partial<T>>(
    (acc, key) => (sameValue(initial[key], current[key]) ? acc : { ...acc, [key]: current[key] }),
    {},
  );
}
