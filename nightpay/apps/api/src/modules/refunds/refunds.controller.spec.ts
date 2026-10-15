import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { RefundsController, ResolvePendingBodySchema } from './refunds.controller';

type RouteArg = { index: number; data?: string; pipes?: unknown[] };

/** Parámetros de ruta (`@Param(nombre, ...pipes)`) de un handler. */
function routeParams(handler: string): RouteArg[] {
  const meta = (Reflect.getMetadata(ROUTE_ARGS_METADATA, RefundsController, handler) ?? {}) as Record<string, RouteArg>;
  return Object.entries(meta)
    .filter(([key]) => key.startsWith('5:')) // RouteParamtypes.PARAM
    .map(([, v]) => v);
}

function hasUuidPipe(arg: RouteArg | undefined): boolean {
  return (arg?.pipes ?? []).some((p) => p === ParseUUIDPipe || p instanceof ParseUUIDPipe);
}

function rolesOf(handler: keyof RefundsController): string[] {
  return Reflect.getMetadata(ROLES_KEY, RefundsController.prototype[handler]) as string[];
}

describe('RefundsController — resolver una devolución pendiente', () => {
  it('solo el dueño, y los dos ids de la ruta son UUID', () => {
    expect(rolesOf('resolvePending')).toEqual(['OWNER']);
    const params = routeParams('resolvePending');
    expect(hasUuidPipe(params.find((p) => p.data === 'id'))).toBe(true);
    expect(hasUuidPipe(params.find((p) => p.data === 'refundId'))).toBe(true);
  });

  it('el cuerpo exige hecha/no hecha y una nota', () => {
    expect(ResolvePendingBodySchema.safeParse({ outcome: 'SUCCEEDED', note: 'Sale en el portal' }).success).toBe(true);
    expect(ResolvePendingBodySchema.safeParse({ outcome: 'MAYBE', note: 'Sale en el portal' }).success).toBe(false);
    expect(ResolvePendingBodySchema.safeParse({ outcome: 'FAILED', note: '  ' }).success).toBe(false);
    expect(ResolvePendingBodySchema.safeParse({ outcome: 'FAILED' }).success).toBe(false);
  });
});
