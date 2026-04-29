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
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Validation failed',
        status: 422,
        detail: result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
        issues: result.error.flatten(),
      });
    }
    return result.data;
  }
}
