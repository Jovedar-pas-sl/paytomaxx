import { z, type ZodTypeAny } from 'zod';

/**
 * Topes de lo que llega de fuera ANTES de pasarlo a zod.
 *
 * GHSA-mrhx-c7xc-m3w5 (zod < 4.6.6): con una lista o un registro enorme
 * cuyos elementos fallan, zod guarda un error por elemento sin tope; en zod 3
 * el `.max()` de una lista no lo evita (valida todos los elementos igual).
 * Con un cuerpo de 1 MB: medio millón de errores, segundos de CPU y cientos
 * de MB (un registro de uniones, como el de los avisos de Redsys: 15 s y
 * 900 MB). Con estos topes zod nunca ve más de unos pocos miles de elementos.
 *
 * Los de por defecto caben de sobra en lo que mandan las apps y los
 * datáfonos: la lista más larga es el cierre de turno del datáfono (2000
 * operaciones, cada una con los campos que da Paytef).
 */
export interface InputLimits {
  /** Elementos de una lista. */
  readonly maxArrayItems: number;
  /** Campos de un objeto. */
  readonly maxObjectKeys: number;
  /** Valores en total (elementos y campos de todos los niveles). */
  readonly maxNodes: number;
  /** Niveles de anidamiento. */
  readonly maxDepth: number;
}

export const INPUT_LIMITS: InputLimits = Object.freeze({
  maxArrayItems: 2_000,
  maxObjectKeys: 500,
  maxNodes: 200_000,
  maxDepth: 32,
});

/** null si cabe; si no, qué se pasa (para el 400). Sin recursión: un JSON muy anidado no la desborda. */
export function inputLimitProblem(value: unknown, overrides: Partial<InputLimits> = {}): string | null {
  const limits: InputLimits = { ...INPUT_LIMITS, ...overrides };
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const { value: current, depth } = pending.pop()!;
    if (typeof current !== 'object' || current === null) continue;
    if (depth >= limits.maxDepth) return `Datos demasiado anidados (máximo ${limits.maxDepth} niveles)`;
    const children = Array.isArray(current) ? current : Object.values(current);
    if (Array.isArray(current) && current.length > limits.maxArrayItems) {
      return `Demasiados elementos en una lista (máximo ${limits.maxArrayItems})`;
    }
    if (!Array.isArray(current) && children.length > limits.maxObjectKeys) {
      return `Demasiados campos en un objeto (máximo ${limits.maxObjectKeys})`;
    }
    nodes += children.length;
    if (nodes > limits.maxNodes) return `Cuerpo demasiado grande (máximo ${limits.maxNodes} valores)`;
    for (const child of children) pending.push({ value: child, depth: depth + 1 });
  }
  return null;
}

/**
 * El mismo esquema, con los topes delante: lo que se pasa ni llega a zod
 * (falla con un solo error). Para lo que se valida fuera del pipe (avisos de
 * las pasarelas). La salida es la del esquema; la entrada, cualquier cosa.
 */
export function boundedInput<S extends ZodTypeAny>(schema: S, overrides: Partial<InputLimits> = {}) {
  return z
    .unknown()
    .superRefine((value, ctx) => {
      const problem = inputLimitProblem(value, overrides);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, fatal: true });
    })
    .pipe(schema);
}
