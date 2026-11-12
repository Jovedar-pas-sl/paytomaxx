// Integración (Postgres real, RLS forzado): «Mi perfil» del personal. La app Nest
// de verdad (Fastify, prefijo /v1, AuthGuard, sesiones con Redis de mentira):
// cada persona cambia solo lo suyo; la foto de otro local no se ve; el encargado
// quita la foto de alguien de su local y de ningún otro; nombre, teléfono, correo,
// contraseña y fotos quedan en el registro; correo repetido, contraseña actual mala
// y topes de peticiones. Ver README.md.
import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as bcrypt from 'bcryptjs';
import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import { ProblemDetailsFilter } from '../../src/common/filters/problem-details.filter';
import { AuthGuard } from '../../src/common/guards/auth.guard';
import { IpRateLimitGuard } from '../../src/common/guards/ip-rate-limit.guard';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/common/redis/redis.module';
import { AuditService } from '../../src/modules/audit/audit.service';
import { MetricsService } from '../../src/modules/metrics/metrics.service';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { CLAIM_STEP_LUA } from '../../src/modules/auth/totp-attempts.service';
import { claimStepScript, createFakeRedis } from '../../src/modules/auth/testing/fake-redis';
import { photoHashesOf } from '../../src/modules/profile/photo-hashes';
import { ProfileModule } from '../../src/modules/profile/profile.module';
import { jpegFixture, pngFixture, SVG_BYTES, webpFixture } from '../support/webp-fixture';

const r = randomUUID().slice(0, 6);
const ORIGIN = 'https://admin.paytomaxx.com';
const COOKIE = 'np_rt_admin.paytomaxx.com';
const PASSWORD = 'Clave-de-prueba-1';
const NEW_PASSWORD = 'Clave-nueva-2026';
const redis = createFakeRedis();
redis.defineScript(CLAIM_STEP_LUA, claimStepScript);

@Global()
@Module({
  providers: [
    { provide: PrismaService, useFactory: (cls: ClsService) => new PrismaService(cls as never), inject: [ClsService] },
    { provide: REDIS_CLIENT, useValue: redis },
    AuditService,
    { provide: MetricsService, useValue: { authLogins: { inc: vi.fn() }, authBodyRefresh: { inc: vi.fn() } } },
  ],
  exports: [PrismaService, REDIS_CLIENT, AuditService, MetricsService],
})
class InfraModule {}

let app: NestFastifyApplication;
let prisma: PrismaService;
let venueA: string;
let venueB: string;
let n = 0;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ JWT_SECRET: 'jwt-de-las-pruebas-de-integracion-0123456789', CORS_ORIGINS: ORIGIN })],
      }),
      ClsModule.forRoot({ global: true, middleware: { mount: true } }),
      InfraModule,
      AuthModule,
      ProfileModule,
    ],
    providers: [
      { provide: APP_GUARD, useClass: IpRateLimitGuard },
      { provide: APP_GUARD, useClass: AuthGuard },
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new ProblemDetailsFilter(false));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);
  await prisma.asSystem(async (tx) => {
    venueA = (await tx.venue.create({ data: { name: `Perfil A ${r}`, slug: `perfil-a-${r}` } })).id;
    venueB = (await tx.venue.create({ data: { name: `Perfil B ${r}`, slug: `perfil-b-${r}` } })).id;
  });
});

afterAll(async () => {
  await app?.close();
});

afterEach(async () => {
  vi.useRealTimers();
  // Todas las peticiones salen de la misma IP: el tope por IP no es lo que se prueba aquí.
  const keys = redis.keys().filter((k) => k.startsWith('nightpay:iprl:'));
  if (keys.length) await redis.del(...keys);
});

interface Person {
  id: string;
  email: string;
  tenantId: string;
}

async function newUser(tenantId: string, role: 'OWNER' | 'MANAGER' | 'WAITER' | 'OPERATOR' = 'WAITER', displayName: string | null = null): Promise<Person> {
  n += 1;
  const email = `perfil-${r}-${n}@local.test`;
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const id = await prisma.asSystem(async (tx) => (await tx.user.create({ data: { tenantId, email, passwordHash, role, displayName } })).id);
  return { id, email, tenantId };
}

function post(url: string, opts: { cookie?: string; body?: unknown } = {}) {
  return app.inject({
    method: 'POST',
    url,
    headers: { origin: ORIGIN, 'x-oxiopay-client': '1', ...(opts.cookie ? { cookie: `${COOKIE}=${opts.cookie}` } : {}) },
    payload: (opts.body ?? {}) as object,
  });
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = String(res.headers['set-cookie'] ?? '');
  if (!raw.startsWith(`${COOKIE}=`)) throw new Error(`Set-Cookie inesperado: ${raw}`);
  return raw.slice(COOKIE.length + 1).split(';')[0]!;
}

async function login(email: string, password = PASSWORD): Promise<{ access: string; cookie: string }> {
  const res = await post('/v1/auth/login', { body: { email, password } });
  expect(res.statusCode).toBe(200);
  return { access: res.json().accessToken as string, cookie: cookieOf(res) };
}

const call = (access: string, method: 'GET' | 'PATCH' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${access}` }, ...(payload ? { payload } : {}) });
const upload = (access: string, bytes: Buffer) => call(access, 'PUT', '/v1/me/photo', { data: bytes.toString('base64') });
const profileOf = async (access: string) => (await call(access, 'GET', '/v1/me/profile')).json();
const audit = (action: string, targetId: string) => prisma.asSystem((tx) => tx.auditEvent.findMany({ where: { action, targetId }, orderBy: { occurredAt: 'asc' } }));
const codeOf = (res: { json: () => unknown }) => (res.json() as { code?: string }).code;
const photoRows = (tenantId: string) => prisma.withTenant(tenantId, (tx) => tx.userPhoto.findMany({ where: { tenantId } }));

describe('Mi perfil: ver y cambiar el nombre y el teléfono (Postgres real)', () => {
  it('GET /me/profile trae el nombre, el correo, el rol, el local y sin foto', async () => {
    const u = await newUser(venueA, 'OPERATOR', 'Marina');
    const s = await login(u.email);
    const p = await profileOf(s.access);
    expect(p).toMatchObject({ userId: u.id, displayName: 'Marina', email: u.email, phone: null, role: 'OPERATOR', venueName: `Perfil A ${r}`, hasPhoto: false, photoHash: null });
  });

  it('cada persona solo cambia lo suyo: ni un userId en el cuerpo ni la ficha de otra persona del local', async () => {
    const a = await newUser(venueA, 'WAITER', 'Ana');
    const b = await newUser(venueA, 'WAITER', 'Berta');
    const sa = await login(a.email);
    const res = await call(sa.access, 'PATCH', '/v1/me/profile', { displayName: 'Ana María', userId: b.id, id: b.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe('Ana María');
    const sb = await login(b.email);
    expect((await profileOf(sb.access)).displayName).toBe('Berta');
    // Tampoco con la foto ni con el teléfono.
    expect((await upload(sa.access, webpFixture({ width: 256, height: 256 }))).statusCode).toBe(200);
    expect((await call(sa.access, 'PATCH', '/v1/me/contact', { phone: '600 111 222', userId: b.id })).statusCode).toBe(200);
    const pb = await profileOf(sb.access);
    expect(pb).toMatchObject({ hasPhoto: false, phone: null });
  });

  it('un nombre malo da 400 y no cambia nada; un cambio deja en el registro el de antes y el de después', async () => {
    const u = await newUser(venueA, 'WAITER', 'Lucía');
    const s = await login(u.email);
    for (const bad of ['', 'L', 'x'.repeat(41), ' Lucía', 'Lu\ncía']) {
      expect((await call(s.access, 'PATCH', '/v1/me/profile', { displayName: bad })).statusCode, bad).toBe(400);
    }
    expect((await profileOf(s.access)).displayName).toBe('Lucía');
    expect((await call(s.access, 'PATCH', '/v1/me/profile', { displayName: 'Lucía P.' })).statusCode).toBe(200);
    // El mismo nombre otra vez no deja otra fila.
    expect((await call(s.access, 'PATCH', '/v1/me/profile', { displayName: 'Lucía P.' })).statusCode).toBe(200);
    const rows = await audit('profile.name.updated', u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: u.id, tenantId: venueA });
    expect(rows[0]!.payload).toEqual({ before: 'Lucía', after: 'Lucía P.' });
  });

  it('el teléfono: se guarda normalizado (el mismo campo del alta), uno inválido da 400, vacío lo quita, y queda en el registro', async () => {
    const u = await newUser(venueA, 'OPERATOR', 'Noa');
    const s = await login(u.email);
    expect((await call(s.access, 'PATCH', '/v1/me/contact', { phone: '12345' })).statusCode).toBe(400);
    const ok = await call(s.access, 'PATCH', '/v1/me/contact', { phone: '600 123 456' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().phone).toBe('+34600123456');
    const stored = await prisma.asSystem((tx) => tx.user.findUniqueOrThrow({ where: { id: u.id }, select: { phone: true } }));
    expect(stored.phone).toBe('+34600123456');
    expect((await call(s.access, 'PATCH', '/v1/me/contact', { phone: '' })).json().phone).toBeNull();
    const rows = await audit('profile.phone.updated', u.id);
    expect(rows.map((x) => x.payload)).toEqual([{ before: null, after: '+34600123456' }, { before: '+34600123456', after: null }]);
  });

  it('sin sesión, 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/me/profile' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PATCH', url: '/v1/me/profile', payload: { displayName: 'Ana' } })).statusCode).toBe(401);
  });
});

describe('Mi perfil: la foto (FORCE RLS)', () => {
  it('sube un WebP, se sirve al personal del mismo local con caché larga y la huella cambia con la foto', async () => {
    const u = await newUser(venueA, 'OPERATOR', 'Iris');
    const mate = await newUser(venueA, 'WAITER', 'Camarero');
    const s = await login(u.email);
    const bytes = webpFixture({ width: 256, height: 256, bytes: 6000 });
    const up = await upload(s.access, bytes);
    expect(up.statusCode).toBe(200);
    const { hasPhoto, photoHash } = up.json();
    expect(hasPhoto).toBe(true);
    expect(photoHash).toMatch(/^[0-9a-f]{64}$/);

    const viewer = await login(mate.email);
    const img = await call(viewer.access, 'GET', `/v1/staff/${u.id}/photo/${photoHash}`);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/webp');
    expect(img.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(img.rawPayload.equals(bytes)).toBe(true);

    // Sin sesión no se ve; una huella vieja o mal escrita tampoco.
    expect((await app.inject({ method: 'GET', url: `/v1/staff/${u.id}/photo/${photoHash}` })).statusCode).toBe(401);
    expect((await call(viewer.access, 'GET', `/v1/staff/${u.id}/photo/${'0'.repeat(64)}`)).statusCode).toBe(404);
    expect((await call(viewer.access, 'GET', `/v1/staff/${u.id}/photo/xyz`)).statusCode).toBe(404);

    // Otra foto (JPEG): otra huella, la vieja ya no sirve.
    const jpeg = jpegFixture({ width: 256, height: 256 });
    const second = await upload(s.access, jpeg);
    expect(second.json().photoHash).not.toBe(photoHash);
    expect((await call(viewer.access, 'GET', `/v1/staff/${u.id}/photo/${photoHash}`)).statusCode).toBe(404);
    const jimg = await call(viewer.access, 'GET', `/v1/staff/${u.id}/photo/${second.json().photoHash}`);
    expect(jimg.headers['content-type']).toBe('image/jpeg');
    expect(await photoRows(venueA).then((rows) => rows.filter((x) => x.userId === u.id))).toHaveLength(1);
  });

  it('la foto de otro local no se ve (404), aunque se sepan el usuario y la huella', async () => {
    const dePerfilA = await newUser(venueA, 'OPERATOR', 'En A');
    const deB = await newUser(venueB, 'WAITER', 'En B');
    const sa = await login(dePerfilA.email);
    const hash = (await upload(sa.access, webpFixture({ width: 256, height: 256 }))).json().photoHash as string;
    const sb = await login(deB.email);
    expect((await call(sb.access, 'GET', `/v1/staff/${dePerfilA.id}/photo/${hash}`)).statusCode).toBe(404);
    // Y con el local B en la sesión, la base no enseña la fila de A aunque la consulta no filtre.
    const seenFromB = await prisma.withTenant(venueB, (tx) => tx.userPhoto.findMany({ where: { userId: dePerfilA.id } }));
    expect(seenFromB).toEqual([]);
  });

  it('rechaza una foto mala: SVG, PNG, enorme, no cuadrada, vacía y base64 roto', async () => {
    const u = await newUser(venueA, 'WAITER', 'Malas');
    const s = await login(u.email);
    for (const bad of [SVG_BYTES, pngFixture({ width: 256, height: 256 }), webpFixture({ width: 256, height: 256, bytes: 160 * 1024 }), webpFixture({ width: 256, height: 128 }), webpFixture({ width: 512, height: 512 })]) {
      expect((await upload(s.access, bad)).statusCode).toBe(400);
    }
    expect((await call(s.access, 'PUT', '/v1/me/photo', { data: '' })).statusCode).toBe(400);
    expect((await call(s.access, 'PUT', '/v1/me/photo', { data: '***no es base64***' })).statusCode).toBe(400);
    expect((await profileOf(s.access)).hasPhoto).toBe(false);
  });

  it('quitar la propia foto: DELETE /me/photo; queda en el registro y la dirección vieja da 404', async () => {
    const u = await newUser(venueA, 'WAITER', 'Quita');
    const s = await login(u.email);
    const hash = (await upload(s.access, webpFixture({ width: 256, height: 256 }))).json().photoHash as string;
    const del = await call(s.access, 'DELETE', '/v1/me/photo');
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ hasPhoto: false, photoHash: null });
    expect((await call(s.access, 'GET', `/v1/staff/${u.id}/photo/${hash}`)).statusCode).toBe(404);
    expect(await audit('profile.photo.set', u.id)).toHaveLength(1);
    expect(await audit('profile.photo.removed', u.id)).toHaveLength(1);
    // Sin foto no hay nada que quitar ni que registrar.
    await call(s.access, 'DELETE', '/v1/me/photo');
    expect(await audit('profile.photo.removed', u.id)).toHaveLength(1);
  });

  it('el encargado quita la foto de alguien de su local, queda en el registro; no la de otro local; un camarero no puede', async () => {
    const chica = await newUser(venueA, 'OPERATOR', 'Foto rara');
    const ajena = await newUser(venueB, 'OPERATOR', 'Foto de B');
    const encargado = await newUser(venueA, 'MANAGER', 'Encargada');
    const camarero = await newUser(venueA, 'WAITER', 'Camarero');
    const sChica = await login(chica.email);
    const sAjena = await login(ajena.email);
    await upload(sChica.access, webpFixture({ width: 256, height: 256 }));
    await upload(sAjena.access, webpFixture({ width: 256, height: 256, fill: 0x77 }));

    const sEnc = await login(encargado.email);
    const sCam = await login(camarero.email);
    expect((await call(sCam.access, 'DELETE', `/v1/staff/${chica.id}/photo`)).statusCode).toBe(403);
    expect((await profileOf(sChica.access)).hasPhoto).toBe(true);

    expect((await call(sEnc.access, 'DELETE', `/v1/staff/${ajena.id}/photo`)).statusCode).toBe(404);
    expect((await profileOf(sAjena.access)).hasPhoto).toBe(true);

    const ok = await call(sEnc.access, 'DELETE', `/v1/staff/${chica.id}/photo`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ removed: true });
    expect((await profileOf(sChica.access)).hasPhoto).toBe(false);
    const rows = await audit('profile.photo.removed_by_staff', chica.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: encargado.id, tenantId: venueA });
    expect((await call(sEnc.access, 'DELETE', `/v1/staff/${chica.id}/photo`)).json()).toEqual({ removed: false });
  });

  it('las listas del panel traen la huella de la foto de su local (y no la de otro)', async () => {
    const enA = await newUser(venueA, 'OPERATOR', 'Lista A');
    const enB = await newUser(venueB, 'OPERATOR', 'Lista B');
    const sa = await login(enA.email);
    const sb = await login(enB.email);
    const hashA = (await upload(sa.access, webpFixture({ width: 256, height: 256, fill: 0x21 }))).json().photoHash as string;
    await upload(sb.access, webpFixture({ width: 256, height: 256, fill: 0x22 }));
    const fromA = await photoHashesOf(prisma, venueA, [enA.id, enB.id]);
    expect([...fromA.keys()]).toEqual([enA.id]);
    expect(fromA.get(enA.id)).toBe(hashA);
    expect((await photoHashesOf(prisma, venueA, [])).size).toBe(0);
  });

  it('el tope de subidas por persona: a la 11.ª en un minuto, 429', async () => {
    const u = await newUser(venueA, 'WAITER', 'Muchas');
    const s = await login(u.email);
    const bytes = webpFixture({ width: 256, height: 256 });
    const codes: number[] = [];
    for (let i = 0; i < 11; i += 1) codes.push((await upload(s.access, bytes)).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

describe('Mi perfil: correo y contraseña (piden la actual)', () => {
  it('correo: contraseña actual mala → 403 con su código y nada cambia; sin contraseña → 400', async () => {
    const u = await newUser(venueA, 'OPERATOR', 'Correo');
    const s = await login(u.email);
    const bad = await call(s.access, 'PATCH', '/v1/me/email', { email: `nuevo-${r}-1@local.test`, currentPassword: 'no-es-esta' });
    expect(bad.statusCode).toBe(403);
    expect(codeOf(bad)).toBe('CURRENT_PASSWORD_WRONG');
    expect((await profileOf(s.access)).email).toBe(u.email);
    expect((await call(s.access, 'PATCH', '/v1/me/email', { email: `nuevo-${r}-1@local.test` })).statusCode).toBe(400);
    expect((await audit('profile.password.check_failed', u.id)).length).toBeGreaterThanOrEqual(1);
  });

  it('correo repetido (también con otras mayúsculas) → 409 EMAIL_TAKEN; el suyo propio no es repetido', async () => {
    const a = await newUser(venueA, 'WAITER', 'Uno');
    const b = await newUser(venueB, 'WAITER', 'Dos');
    const sa = await login(a.email);
    for (const email of [b.email, b.email.toUpperCase()]) {
      const res = await call(sa.access, 'PATCH', '/v1/me/email', { email, currentPassword: PASSWORD });
      expect(res.statusCode).toBe(409);
      expect(codeOf(res)).toBe('EMAIL_TAKEN');
    }
    expect((await call(sa.access, 'PATCH', '/v1/me/email', { email: a.email.toUpperCase(), currentPassword: PASSWORD })).statusCode).toBe(200);
    expect((await profileOf(sa.access)).email).toBe(a.email);
  });

  it('correo nuevo: queda el de antes y el de ahora en el registro, entra con el nuevo, este móvil sigue y las demás sesiones se cierran', async () => {
    const u = await newUser(venueA, 'OPERATOR', 'Cambio');
    const movil = await login(u.email);
    const otra = await login(u.email);
    const nuevo = `cambiado-${r}@local.test`;
    const res = await call(movil.access, 'PATCH', '/v1/me/email', { email: `  ${nuevo.toUpperCase()} `, currentPassword: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe(nuevo);
    const rows = await audit('profile.email.changed', u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ before: u.email, after: nuevo, otherSessionsClosed: 1 });

    expect((await call(movil.access, 'GET', '/v1/me/profile')).statusCode).toBe(200);
    expect((await post('/v1/auth/refresh', { cookie: movil.cookie })).statusCode).toBe(200);
    expect((await call(otra.access, 'GET', '/v1/me/profile')).statusCode).toBe(401);
    expect((await post('/v1/auth/refresh', { cookie: otra.cookie })).statusCode).toBe(401);

    expect((await post('/v1/auth/login', { body: { email: u.email, password: PASSWORD } })).statusCode).toBe(401);
    expect((await post('/v1/auth/login', { body: { email: nuevo, password: PASSWORD } })).statusCode).toBe(200);
  });

  it('contraseña: la actual mala → 403 y no cambia; distinta/corta/repetida mal → 400', async () => {
    const u = await newUser(venueA, 'WAITER', 'Clave');
    const s = await login(u.email);
    const mala = await call(s.access, 'POST', '/v1/me/password', { currentPassword: 'no-es-esta', newPassword: NEW_PASSWORD, newPasswordRepeat: NEW_PASSWORD });
    expect(mala.statusCode).toBe(403);
    expect(codeOf(mala)).toBe('CURRENT_PASSWORD_WRONG');
    for (const body of [
      { currentPassword: PASSWORD, newPassword: 'corta', newPasswordRepeat: 'corta' },
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, newPasswordRepeat: `${NEW_PASSWORD}x` },
      { currentPassword: PASSWORD, newPassword: PASSWORD, newPasswordRepeat: PASSWORD },
    ]) {
      expect((await call(s.access, 'POST', '/v1/me/password', body)).statusCode).toBe(400);
    }
    expect((await post('/v1/auth/login', { body: { email: u.email, password: PASSWORD } })).statusCode).toBe(200);
  });

  it('contraseña nueva: entra con la nueva y no con la vieja, este móvil sigue (también al refrescar) y las demás sesiones se cierran; queda en el registro sin la contraseña', async () => {
    const u = await newUser(venueA, 'WAITER', 'Nueva');
    const movil = await login(u.email);
    const otra = await login(u.email);
    const res = await call(movil.access, 'POST', '/v1/me/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, newPasswordRepeat: NEW_PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ changed: true, otherSessionsClosed: 1 });

    expect((await call(movil.access, 'GET', '/v1/me/profile')).statusCode).toBe(200);
    expect((await post('/v1/auth/refresh', { cookie: movil.cookie })).statusCode).toBe(200);
    expect((await call(otra.access, 'GET', '/v1/me/profile')).statusCode).toBe(401);
    expect((await post('/v1/auth/refresh', { cookie: otra.cookie })).statusCode).toBe(401);
    expect((await post('/v1/auth/login', { body: { email: u.email, password: PASSWORD } })).statusCode).toBe(401);
    expect((await post('/v1/auth/login', { body: { email: u.email, password: NEW_PASSWORD } })).statusCode).toBe(200);

    const rows = await audit('profile.password.changed', u.id);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.payload)).not.toContain(NEW_PASSWORD);
  });

  it('el tope de intentos con contraseña: a la 6.ª en diez minutos, 429 (el correo y la contraseña comparten el tope)', async () => {
    const u = await newUser(venueA, 'WAITER', 'Tope');
    const s = await login(u.email);
    const codes: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      codes.push((await call(s.access, 'POST', '/v1/me/password', { currentPassword: 'mala-mala', newPassword: NEW_PASSWORD, newPasswordRepeat: NEW_PASSWORD })).statusCode);
    }
    expect(codes.slice(0, 5).every((c) => c === 403)).toBe(true);
    expect(codes[5]).toBe(429);
    expect((await call(s.access, 'PATCH', '/v1/me/email', { email: `tope-${r}@local.test`, currentPassword: PASSWORD })).statusCode).toBe(429);
  });
});

describe('migración 20261113100000_fotos_personal (Postgres real)', () => {
  it('se puede repetir, la base rechaza lo que no es una foto de perfil y una foto no es de otro local que su persona; se va con la persona', async () => {
    const u = await newUser(venueA, 'OPERATOR', 'Migración');
    const row = (over: Record<string, unknown> = {}) => ({
      userId: u.id, tenantId: venueA, contentType: 'image/webp', data: Buffer.alloc(64, 3), contentHash: 'c'.repeat(64), width: 256, height: 256, ...over,
    });
    const tryInsert = (data: Record<string, unknown>) =>
      prisma.asSystem((tx) => tx.userPhoto.create({ data: data as never })).then(() => 'ok', (e: Error) => e.message);
    for (const bad of [{ contentType: 'image/svg+xml' }, { contentType: 'image/png' }, { data: Buffer.alloc(150 * 1024 + 1, 1) }, { width: 512, height: 512 }, { width: 16, height: 16 }, { contentHash: 'XYZ' }]) {
      expect(await tryInsert(row(bad)), JSON.stringify(Object.keys(bad))).toMatch(/user_photos_|check constraint|violates/i);
    }
    // Una foto de otro local que el de su persona: la clave ajena (persona, local) la rechaza.
    expect(await tryInsert(row({ tenantId: venueB }))).toMatch(/foreign key|user_photos_userId_tenantId_fkey/i);
    expect(await tryInsert(row())).toBe('ok');

    const cli = join(__dirname, '../../../../packages/db/node_modules/prisma/build/index.js');
    const file = join(__dirname, '../../../../packages/db/prisma/migrations/20261113100000_fotos_personal/migration.sql');
    for (let i = 0; i < 2; i += 1) {
      const res = spawnSync(process.execPath, [cli, 'db', 'execute', '--url', String(process.env.DATABASE_URL), '--file', file], { encoding: 'utf8', env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' } });
      expect(res.status, `${res.stdout}
${res.stderr}`).toBe(0);
    }
    expect(await photoRows(venueA).then((rows) => rows.filter((x) => x.userId === u.id))).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toMatch(/SET lock_timeout = '5s'/);
    await prisma.asSystem((tx) => tx.user.delete({ where: { id: u.id } }));
    expect(await photoRows(venueA).then((rows) => rows.filter((x) => x.userId === u.id))).toHaveLength(0);
  });
});
