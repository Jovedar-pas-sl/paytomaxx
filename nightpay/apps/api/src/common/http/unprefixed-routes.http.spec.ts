import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestMethod, type Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { UNPREFIXED_ROUTES } from './unprefixed-routes';

/**
 * Con la app Nest de verdad (Fastify y el mismo setGlobalPrefix que main.ts):
 * cada ruta @Public de los controladores de las páginas del cliente (pay, w,
 * s) se sirve SIN /v1. Los controladores se buscan en src/modules (uno nuevo
 * entra solo) y sus servicios son de mentira (useMocker).
 *
 * Así no vuelve a pasar lo de «Recargar»: POST /w/:token/topup quedó en
 * /v1/w/... y la página, que lo llama sin /v1, daba 404.
 */
const CUSTOMER_SEGMENTS = new Set(['pay', 'w', 's']);
const MODULES_DIR = join(__dirname, '..', '..', 'modules');

interface PublicRoute {
  method: RequestMethod;
  path: string;
}

function trimSlashes(p: string): string {
  return p.replace(/^\/+|\/+$/g, '');
}

async function customerControllers(): Promise<Type[]> {
  const files = (readdirSync(MODULES_DIR, { recursive: true }) as string[]).filter((f) => f.endsWith('.controller.ts'));
  const found: Type[] = [];
  for (const file of files) {
    const mod = (await import(join(MODULES_DIR, file))) as Record<string, unknown>;
    for (const value of Object.values(mod)) {
      if (typeof value !== 'function') continue;
      const path = Reflect.getMetadata(PATH_METADATA, value) as string | undefined;
      if (path !== undefined && CUSTOMER_SEGMENTS.has(trimSlashes(path))) found.push(value as Type);
    }
  }
  return found;
}

function publicRoutes(controller: Type): PublicRoute[] {
  const base = trimSlashes(Reflect.getMetadata(PATH_METADATA, controller) as string);
  const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, controller) === true;
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).flatMap((name) => {
    const handler = proto[name];
    if (name === 'constructor' || typeof handler !== 'function') return [];
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
    if (method === undefined) return [];
    if (!classPublic && Reflect.getMetadata(IS_PUBLIC_KEY, handler) !== true) return [];
    const raw = Reflect.getMetadata(PATH_METADATA, handler) as string | string[];
    return (Array.isArray(raw) ? raw : [raw]).map((p) => ({ method, path: [base, trimSlashes(p)].filter(Boolean).join('/') }));
  });
}

let app: NestFastifyApplication;
let routes: PublicRoute[];

beforeAll(async () => {
  const controllers = await customerControllers();
  routes = controllers.flatMap(publicRoutes);
  const moduleRef = await Test.createTestingModule({ controllers }).useMocker(() => ({})).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1', { exclude: [...UNPREFIXED_ROUTES] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('páginas del cliente fuera de /v1', () => {
  it('encuentra los controladores de pay, w y s (con sus acciones de «Recargar»)', () => {
    const paths = routes.map((r) => `${RequestMethod[r.method]} ${r.path}`);
    expect(paths).toEqual(
      expect.arrayContaining(['GET pay/:token', 'POST w/:token/topup', 'POST w/:token/topup/challenge', 'POST s/:token/pay']),
    );
  });

  it('cada ruta @Public de pay, w y s se sirve sin /v1', () => {
    const fastify = app.getHttpAdapter().getInstance();
    const prefixed = routes
      .filter((r) => !fastify.hasRoute({ method: RequestMethod[r.method] as 'GET', url: `/${r.path}` }))
      .map((r) => `${RequestMethod[r.method]} /${r.path}`);
    // Si falla: añade la ruta a UNPREFIXED_ROUTES (common/http/unprefixed-routes.ts).
    expect(prefixed).toEqual([]);
  });

  it('la lista no tiene rutas que ya no existen', () => {
    const known = new Set(routes.map((r) => `${r.method} ${r.path}`));
    const stale = UNPREFIXED_ROUTES.filter((r) => !known.has(`${r.method} ${r.path}`)).map((r) => r.path);
    expect(stale).toEqual([]);
  });
});
