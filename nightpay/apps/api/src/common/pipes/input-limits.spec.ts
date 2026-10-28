import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { INPUT_LIMITS, boundedInput, inputLimitProblem } from './input-limits';
import { ZodValidationPipe } from './zod.pipe';

/**
 * GHSA-mrhx-c7xc-m3w5 (zod < 4.6.6): con una lista o un registro enorme cuyos
 * elementos fallan, zod guarda un error por elemento sin tope. En zod 3 el
 * `.max()` de una lista NO lo evita (valida todos los elementos igual): con
 * un cuerpo de 1 MB, segundos de CPU y cientos de MB. Por eso los topes van
 * ANTES de zod (SEC-05).
 */

/** Lo más grande que cabe en un cuerpo de 1 MB: medio millón de elementos. */
const hugeArray = (): number[] => new Array(500_000).fill(0);
const hugeRecord = (): Record<string, unknown> => Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, {}]));

describe('topes de entrada antes de zod', () => {
  it('cuerpos normales pasan', () => {
    expect(inputLimitProblem({ email: 'a@b.es', password: 'x', items: [1, 2, 3], deep: { a: { b: 1 } } })).toBeNull();
    expect(inputLimitProblem({ transactions: new Array(INPUT_LIMITS.maxArrayItems).fill({ a: 1, b: '2' }) })).toBeNull();
    expect(inputLimitProblem('texto')).toBeNull();
    expect(inputLimitProblem(undefined)).toBeNull();
  });

  it('una lista, un objeto, el total o la profundidad por encima del tope: no pasa', () => {
    expect(inputLimitProblem({ items: new Array(INPUT_LIMITS.maxArrayItems + 1).fill(0) })).toMatch(/lista/);
    expect(inputLimitProblem(Object.fromEntries(Array.from({ length: INPUT_LIMITS.maxObjectKeys + 1 }, (_, i) => [`k${i}`, 1])))).toMatch(
      /campos/,
    );
    const wide = Array.from({ length: 200 }, () => Array.from({ length: 1_500 }, () => 0));
    expect(inputLimitProblem(wide)).toMatch(/demasiado grande/);
    let deep: unknown = 1;
    for (let i = 0; i < INPUT_LIMITS.maxDepth + 2; i++) deep = [deep];
    expect(inputLimitProblem(deep)).toMatch(/anidad/);
  });

  it('el pipe de validación corta un cuerpo enorme sin llegar a zod (400 en poco tiempo)', () => {
    const schema = z.object({ items: z.array(z.string()).max(10) });
    const parse = vi.spyOn(schema, 'safeParse');
    const pipe = new ZodValidationPipe(schema);
    const started = Date.now();
    expect(() => pipe.transform({ items: hugeArray() })).toThrow(BadRequestException);
    expect(Date.now() - started).toBeLessThan(500);
    expect(parse).not.toHaveBeenCalled();
  });

  it('el 400 del pipe no lista miles de errores (el cuerpo de la respuesta también tiene tope)', () => {
    const pipe = new ZodValidationPipe(z.object({ items: z.array(z.string()) }));
    let body: Record<string, unknown> = {};
    try {
      pipe.transform({ items: new Array(INPUT_LIMITS.maxArrayItems).fill(0) });
    } catch (err) {
      body = (err as BadRequestException).getResponse() as Record<string, unknown>;
    }
    expect(String(body.detail).split('; ').length).toBeLessThanOrEqual(21);
    expect(String(body.detail)).toMatch(/y \d+ más/);
    expect(JSON.stringify(body).length).toBeLessThan(10_000);
  });

  it('boundedInput: el esquema de siempre, pero un registro enorme no llega a zod', () => {
    const parse = vi.fn();
    const record = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).superRefine(parse);
    const bounded = boundedInput(record, { maxObjectKeys: 100 });
    expect(bounded.safeParse({ Ds_Signature: 's', Ds_MerchantParameters: 'p' })).toEqual({
      success: true,
      data: { Ds_Signature: 's', Ds_MerchantParameters: 'p' },
    });
    expect(parse).toHaveBeenCalled();
    parse.mockClear();
    const input = hugeRecord();
    const started = Date.now();
    expect(bounded.safeParse(input).success).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
    expect(parse).not.toHaveBeenCalled();
  });
});
