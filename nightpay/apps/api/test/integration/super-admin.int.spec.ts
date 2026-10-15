// Integración (Postgres real): super-admin con otro local activo. Ver README.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { AdminController } from '../../src/modules/admin/admin.controller';

const cls = new ClsService(new AsyncLocalStorage());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prisma = new PrismaService(cls as any);
const audit = { log: async () => undefined };
const jwt = new JwtService({ secret: 'x'.repeat(40) });
const auth = new AuthService(prisma as never, jwt, {} as never, audit as never, {} as never, {} as never);
const admin = new AdminController(prisma as never, {} as never, audit as never, {} as never, {} as never, cls as never);

function inVenue<T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('ctx', { tenantId, traceId: 't' });
    return fn();
  });
}

const r = randomUUID().slice(0, 6);
let A: string, B: string, C: string, superAdmin: string;

beforeAll(async () => {
  await prisma.onModuleInit();
  await inVenue(undefined, () =>
    prisma.asSystem(async (tx) => {
      A = (await tx.venue.create({ data: { name: 'Casa', slug: `sa-${r}` } })).id;
      B = (await tx.venue.create({ data: { name: 'Otro', slug: `sb-${r}` } })).id;
      C = (await tx.venue.create({ data: { name: 'Tercero', slug: `sc-${r}` } })).id;
      superAdmin = (
        await tx.user.create({
          data: { tenantId: A, email: `super-${r}@x.es`, passwordHash: 'x', role: 'OWNER', isSuperAdmin: true },
        })
      ).id;
    }),
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('super-admin con OTRO local activo (Postgres real)', () => {
  it('así fallaba: buscar al usuario con el filtro del local activo no lo encuentra', async () => {
    const u = await inVenue(B, () => prisma.asSystem((tx) => tx.user.findUnique({ where: { id: superAdmin } })));
    expect(u).toBeNull();
  });

  it('puede listar los locales (el desplegable no desaparece)', async () => {
    const venues = (await inVenue(B, () =>
      admin.listAllVenues({ sub: superAdmin, tenantId: B, role: 'OWNER' } as never),
    )) as Array<{ id: string }>;
    expect(venues.map((v) => v.id)).toEqual(expect.arrayContaining([A, B, C]));
  });

  it('puede cambiar de un local ajeno a otro, sin perder su rol', async () => {
    const res = await inVenue(B, () => auth.switchTenant(superAdmin, C));
    expect(res.tenantId).toBe(C);
    const claims = jwt.decode(res.accessToken) as { tenantId: string; role: string; sub: string };
    expect(claims).toMatchObject({ tenantId: C, role: 'OWNER', sub: superAdmin });
    // Y volver a su local.
    const back = await inVenue(C, () => auth.switchTenant(superAdmin, A));
    expect(back.tenantId).toBe(A);
  });

  it('un usuario normal sigue sin poder (403)', async () => {
    const normal = await inVenue(undefined, () =>
      prisma.asSystem((tx) =>
        tx.user.create({ data: { tenantId: B, email: `normal-${r}@x.es`, passwordHash: 'x', role: 'OWNER' } }),
      ),
    );
    await expect(inVenue(B, () => auth.switchTenant(normal.id, C))).rejects.toThrow(/super admins/);
    await expect(
      inVenue(B, () => admin.listAllVenues({ sub: normal.id, tenantId: B, role: 'OWNER' } as never)),
    ).rejects.toThrow(/super admins/);
  });
});
