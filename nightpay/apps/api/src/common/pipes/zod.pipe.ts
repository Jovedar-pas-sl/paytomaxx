import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';

/**
 * Acepta cualquier schema Zod. El input puede diferir del output
 * (e.g. `.default()` o `.transform()` cambian la forma) — necesario para
 * que TS no falle cuando los tipos de entrada/salida del schema divergen.
 */
export class ZodValidationPipe<S extends ZodTypeAny>
  implements PipeTransform<unknown, z.output<S>>
{
  private readonly schema: S;

  constructor(schema: S) {
    this.schema = schema;
  }

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      // 400, como siempre (las apps lo esperan así: un 422 es, p. ej., «PIN
      // mal» en el datáfono). El filtro pone `status` en el cuerpo: el mismo.
      throw new BadRequestException({
        title: 'Validation failed',
        detail: result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
        issues: result.error.flatten(),
      });
    }
    return result.data;
  }
}
