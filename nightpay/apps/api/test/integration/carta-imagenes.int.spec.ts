import 'reflect-metadata';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ClsService } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthGuard } from '../../src/common/guards/auth.guard';
import { IS_PUBLIC_KEY } from '../../src/common/decorators/public.decorator';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CartaController, CartaImageController } from '../../src/modules/carta/carta.controller';
import { CartaService } from '../../src/modules/carta/carta.service';
import { JPEG_BYTES, PNG_BYTES, SVG_AS_WEBP, SVG_BYTES, webpFixture } from '../support/webp-fixture';

const cls = new ClsService(new AsyncLocalStorage());
const prisma = new PrismaService(cls as never);
const venues: string[] = [];
let app: NestFastifyApplication;

beforeAll(async () => {
  await prisma.onModuleInit();
  const ref = await Test.createTestingModule({
    controllers: [CartaController, CartaImageController],
    providers: [CartaService, { provide: PrismaService, useValue: prisma }, { provide: AuditService, useValue: { log: async () => undefined } }],
  })
    .overrideGuard(AuthGuard)
    .useValue({
      canActivate(context: ExecutionContext) {
        if (new Reflector().getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;
        const request = context.switchToHttp().getRequest();
        const tenant = request.headers['x-test-tenant'];
        if (!tenant) throw new UnauthorizedException();
        request.user = { sub: randomUUID(), tenantId: tenant, role: request.headers['x-test-role'] ?? 'OWNER' };
        return true;
      },
    })
    .compile();
  app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1');
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
  await prisma.asSystem(async (tx) => {
    await tx.serviceItem.deleteMany({ where: { tenantId: { in: venues } } });
    await tx.venue.deleteMany({ where: { id: { in: venues } } });
  });
  await prisma.onApplicationShutdown();
});

async function venue() {
  const row = await prisma.asSystem((tx) => tx.venue.create({ data: { name: 'Carta imágenes prueba', slug: `img-${randomUUID()}` } }));
  venues.push(row.id);
  return row.id;
}
async function product(tenantId: string, name = 'Gin tonic') {
  return prisma.withTenant(tenantId, (tx) => tx.serviceItem.create({ data: { tenantId, name, priceCents: 1200, category: 'VENUE_BAR' } }));
}
const as = (tenantId: string, role = 'OWNER') => ({ 'x-test-tenant': tenantId, 'x-test-role': role });
const upload = (tenantId: string, id: string, bytes: Buffer, role = 'OWNER') =>
  app.inject({ method: 'PUT', url: `/v1/services/${id}/image`, headers: as(tenantId, role), payload: { data: bytes.toString('base64') } });
const rows = (tenantId: string) => prisma.withTenant(tenantId, (tx) => tx.serviceItemImage.findMany({ where: { tenantId } }));

describe('carta con logo o foto: subir, servir y quitar (Postgres real, RLS forzado)', () => {
  it('sube un WebP, la carta trae su ruta versionada y se sirve con caché de un año', async () => {
    const t = await venue();
    const item = await product(t);
    const bytes = webpFixture();
    const up = await upload(t, item.id, bytes);
    expect(up.statusCode).toBe(200);
    const body = up.json();
    expect(body.imageUrl).toMatch(new RegExp(`^/v1/services/${item.id}/image/[0-9a-f]{64}$`));

    const list = await app.inject({ method: 'GET', url: '/v1/services/all', headers: as(t) });
    expect(list.json().find((i: { id: string }) => i.id === item.id).imageUrl).toBe(body.imageUrl);

    const img = await app.inject({ method: 'GET', url: body.imageUrl }); // sin sesión: la pide un <img>
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/webp');
    expect(img.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(img.rawPayload.equals(bytes)).toBe(true);
  });

  it('cambiar la imagen cambia la ruta; la ruta vieja ya no sirve; la misma imagen deja la misma ruta', async () => {
    const t = await venue();
    const item = await product(t);
    const first = (await upload(t, item.id, webpFixture())).json().imageUrl as string;
    const again = (await upload(t, item.id, webpFixture())).json().imageUrl as string;
    expect(again).toBe(first);
    const second = (await upload(t, item.id, webpFixture({ fill: 0x11 }))).json().imageUrl as string;
    expect(second).not.toBe(first);
    expect((await app.inject({ method: 'GET', url: first })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: second })).statusCode).toBe(200);
    expect(await rows(t)).toHaveLength(1);
  });

  it('quitar borra la imagen (la ruta da 404) y quitarla otra vez no falla', async () => {
    const t = await venue();
    const item = await product(t);
    const url = (await upload(t, item.id, webpFixture())).json().imageUrl as string;
    const del = await app.inject({ method: 'DELETE', url: `/v1/services/${item.id}/image`, headers: as(t) });
    expect(del.statusCode).toBe(200);
    expect(del.json().imageUrl).toBeNull();
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/v1/services/${item.id}/image`, headers: as(t) })).statusCode).toBe(200);
    expect(await rows(t)).toHaveLength(0);
  });

  it('no guarda SVG (ni disfrazado), PNG, JPEG, más de 64 KB ni medidas raras; no queda nada en la base', async () => {
    const t = await venue();
    const item = await product(t);
    const bads = [SVG_BYTES, SVG_AS_WEBP, PNG_BYTES, JPEG_BYTES, webpFixture({ bytes: 64 * 1024 + 1 }), webpFixture({ width: 256, height: 256 }), webpFixture({ width: 128, height: 64 })];
    for (const bad of bads) {
      const res = await upload(t, item.id, bad);
      expect(res.statusCode, bad.subarray(0, 12).toString('latin1')).toBe(400);
    }
    expect(await rows(t)).toHaveLength(0);
  });

  it('el local no puede tocar el producto de otro (404) y el que tiene el producto sigue igual', async () => {
    const a = await venue();
    const b = await venue();
    const item = await product(a);
    const url = (await upload(a, item.id, webpFixture())).json().imageUrl as string;
    expect((await upload(b, item.id, webpFixture({ fill: 0x22 }))).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/v1/services/${item.id}/image`, headers: as(b) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect(await rows(b)).toHaveLength(0);
    const listB = await app.inject({ method: 'GET', url: '/v1/services/all', headers: as(b) });
    expect(listB.json()).toEqual([]);
  });

  it('una huella de otro producto no sirve la imagen (producto + huella tienen que coincidir)', async () => {
    const t = await venue();
    const one = await product(t, 'Uno');
    const two = await product(t, 'Dos');
    const urlOne = (await upload(t, one.id, webpFixture())).json().imageUrl as string;
    const hash = urlOne.split('/').pop();
    expect((await app.inject({ method: 'GET', url: `/v1/services/${two.id}/image/${hash}` })).statusCode).toBe(404);
  });

  it('solo el dueño y el encargado: el camarero no sube', async () => {
    const t = await venue();
    const item = await product(t);
    expect((await upload(t, item.id, webpFixture(), 'WAITER')).statusCode).toBe(403);
    expect(await rows(t)).toHaveLength(0);
  });

  it('RLS forzado: con el local B en la sesión no se ve la imagen de A, y la base rechaza un local distinto del producto', async () => {
    const a = await venue();
    const b = await venue();
    const item = await product(a);
    const other = await product(a, 'Sin imagen');
    await upload(a, item.id, webpFixture());
    const seen = await prisma.withTenant(b, (tx) => tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM service_item_images`);
    expect(Number(seen[0]!.n)).toBe(0);
    const forged = await prisma
      .asSystem((tx) => tx.$executeRaw`INSERT INTO service_item_images ("serviceItemId","tenantId","data","contentHash","width","height") VALUES (${other.id}::uuid, ${b}::uuid, ${webpFixture()}, ${'e'.repeat(64)}, 128, 128)`)
      .then(() => 'insertada', (e: Error) => e.message);
    expect(forged).toMatch(/foreign key|service_item_images_item_fkey/i);
    const asB = await prisma
      .withTenant(b, (tx) => tx.$executeRaw`INSERT INTO service_item_images ("serviceItemId","tenantId","data","contentHash","width","height") VALUES (${other.id}::uuid, ${a}::uuid, ${webpFixture()}, ${'f'.repeat(64)}, 128, 128)`)
      .then(() => 'insertada', (e: Error) => e.message);
    expect(asB).not.toBe('insertada');
  });

  it('el icono: se guarda por PATCH, null lo quita y la base solo deja los de la colección', async () => {
    const t = await venue();
    const item = await product(t);
    const set = await app.inject({ method: 'PATCH', url: `/v1/services/${item.id}`, headers: as(t), payload: { icon: 'gin_tonic' } });
    expect(set.json().icon).toBe('gin_tonic');
    const bad = await app.inject({ method: 'PATCH', url: `/v1/services/${item.id}`, headers: as(t), payload: { icon: 'logo_de_marca' } });
    expect(bad.statusCode).toBe(400);
    const sql = await prisma.asSystem((tx) => tx.$executeRaw`UPDATE service_items SET icon = 'x' WHERE id = ${item.id}::uuid`).then(() => 'ok', (e: Error) => e.message);
    expect(sql).toMatch(/service_items_icon_known|check constraint/i);
    const off = await app.inject({ method: 'PATCH', url: `/v1/services/${item.id}`, headers: as(t), payload: { icon: null } });
    expect(off.json().icon).toBeNull();
  });

  it('la migración se puede repetir sin tocar nada y borrar el producto borra su imagen (cascada)', async () => {
    const t = await venue();
    const item = await product(t);
    await upload(t, item.id, webpFixture());
    const cli = join(__dirname, '../../../../packages/db/node_modules/prisma/build/index.js');
    const file = join(__dirname, '../../../../packages/db/prisma/migrations/20261111100000_carta_imagenes/migration.sql');
    for (let i = 0; i < 2; i += 1) {
      const res = spawnSync(process.execPath, [cli, 'db', 'execute', '--url', String(process.env.DATABASE_URL), '--file', file], { encoding: 'utf8', env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' } });
      expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    }
    expect(await rows(t)).toHaveLength(1);
    await prisma.withTenant(t, (tx) => tx.serviceItem.delete({ where: { id: item.id } }));
    expect(await rows(t)).toHaveLength(0);
  });
});
