import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  private readonly schema: ZodSchema<T>;

  constructor(schema: ZodSchema<T>) {
    this.schema = schema;
  }

  transform(value: unknown): T {
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
