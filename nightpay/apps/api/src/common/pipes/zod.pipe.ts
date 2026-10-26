import { BadRequestException, PipeTransform } from '@nestjs/common';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { inputLimitProblem } from './input-limits';

/** Errores que se cuentan en el 400 (el resto, «y N más»). */
const MAX_REPORTED_ISSUES = 20;

/**
 * Acepta cualquier schema Zod. El input puede diferir del output
 * (e.g. `.default()` o `.transform()` cambian la forma) — necesario para
 * que TS no falle cuando los tipos de entrada/salida del schema divergen.
 *
 * Antes de zod, los topes de input-limits.ts (listas, campos, total y
 * profundidad): un cuerpo con una colección enorme no llega a validarse
 * (GHSA-mrhx-c7xc-m3w5).
 */
export class ZodValidationPipe<S extends ZodTypeAny>
  implements PipeTransform<unknown, z.output<S>>
{
  private readonly schema: S;

  constructor(schema: S) {
    this.schema = schema;
  }

  transform(value: unknown): z.output<S> {
    const tooBig = inputLimitProblem(value);
    if (tooBig) throw new BadRequestException({ title: 'Validation failed', detail: tooBig });
    const result = this.schema.safeParse(value);
    if (!result.success) {
      // 400, como siempre (las apps lo esperan así: un 422 es, p. ej., «PIN
      // mal» en el datáfono). El filtro pone `status` en el cuerpo: el mismo.
      const issues = result.error.issues;
      const shown = issues.slice(0, MAX_REPORTED_ISSUES);
      const more = issues.length - shown.length;
      throw new BadRequestException({
        title: 'Validation failed',
        detail: [
          ...shown.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
          ...(more > 0 ? [`y ${more} más`] : []),
        ].join('; '),
        issues: (more > 0 ? new ZodError(shown) : result.error).flatten(),
      });
    }
    return result.data;
  }
}
