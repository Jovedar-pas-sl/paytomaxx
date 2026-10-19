import {
  BadRequestException,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

const HEADER = 'idempotency-key';
const MAX_LEN = 200;
const KEY_RX = /^[A-Za-z0-9_-]{8,}$/;

/** La clave de la cabecera ya validada; null si no viene. 400 si viene mal formada. */
export function idempotencyKeyOf(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  if (value.length > MAX_LEN || !KEY_RX.test(value)) {
    throw new BadRequestException(
      `Invalid Idempotency-Key (must be 8-${MAX_LEN} chars [A-Za-z0-9_-])`,
    );
  }
  return value;
}

/**
 * Extrae el header `Idempotency-Key`. Obligatorio en mutaciones financieras.
 * Acepta letras/números/guiones, 8..200 chars (alineado con stripe RFC).
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const value = idempotencyKeyOf(req.headers[HEADER]);
    if (!value) {
      throw new BadRequestException(`Missing required header: Idempotency-Key`);
    }
    return value;
  },
);

/** Como IdempotencyKey, pero si no viene la cabecera da null (apps que aún no la mandan). */
export const OptionalIdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null =>
    idempotencyKeyOf(ctx.switchToHttp().getRequest<FastifyRequest>().headers[HEADER]),
);
