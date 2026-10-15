import { describe, it, expect, vi } from 'vitest';
import { ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RedsysDebugController } from './redsys-debug.controller';

const SECRET = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';

function makeController(env: Record<string, string> = {}, rows: unknown[] = []) {
  const values: Record<string, string> = {
    REDSYS_MERCHANT_CODE: '999008881',
    REDSYS_TERMINAL: '1',
    REDSYS_SECRET_KEY: SECRET,
    REDSYS_API_URL: 'https://sis.redsys.es/sis/realizarPago',
    NEXT_PUBLIC_API_URL: 'https://api.paytomaxx.com',
    ...env,
  };
  const config = { get: vi.fn((k: string) => values[k]) };
  const queryRaw = vi.fn().mockResolvedValue(rows);
  const queryRawUnsafe = vi.fn();
  const prisma = {
    asSystem: vi.fn((fn: (tx: unknown) => unknown) => fn({ $queryRaw: queryRaw })),
    $queryRawUnsafe: queryRawUnsafe,
  };
  const redsys = { getStatus: vi.fn().mockResolvedValue('AUTHORIZED') };
  const controller = new RedsysDebugController(config as never, prisma as never, redsys as never);
  return { controller, queryRaw, queryRawUnsafe, prisma };
}

describe('RedsysDebugController: sin secretos ni datos de tarjeta', () => {
  it('keycheck dice si la clave vale, sin su longitud ni si está', () => {
    const { controller } = makeController();
    const res = controller.keycheck() as unknown as Record<string, unknown>;
    expect(res.secretKeyOk).toBe(true);
    for (const key of ['secretKeyLength', 'secretKeyPresent', 'secretKeyLooksBase64', 'merchantCodeLength']) {
      expect(res).not.toHaveProperty(key);
    }
    expect(JSON.stringify(res)).not.toContain(SECRET);
    const mala = makeController({ REDSYS_SECRET_KEY: 'corta' }).controller.keycheck();
    expect(mala.secretKeyOk).toBe(false);
    expect(mala.hint).not.toMatch(/\d+ chars/);
  });

  it('last-tokenized no devuelve tokenizationData (token de la tarjeta)', async () => {
    const { controller } = makeController({}, [
      { id: 'p1', providerTxId: 'o1', amountCents: 1, createdAt: new Date(), tokenizationData: { Ds_Merchant_Identifier: 'TOK' } },
    ]);
    const res = await controller.lastTokenized();
    expect(res.found).toBe(true);
    expect(JSON.stringify(res)).not.toContain('TOK');
    expect(res.payment).not.toHaveProperty('tokenizationData');
  });

  it('recent-webhooks sin el cuerpo crudo del aviso', async () => {
    const { controller } = makeController({}, [
      { id: 1n, provider: 'REDSYS', externalEventId: 'e1', processedAt: null, createdAt: new Date(), rawBodyBytes: 512 },
    ]);
    const res = await controller.recentWebhooks();
    expect(res.webhooks[0]).not.toHaveProperty('rawBodyPreview');
    expect(res.webhooks[0]!.rawBodyBytes).toBe(512);
  });

  it('consultas parametrizadas dentro de asSystem (nunca $queryRawUnsafe)', async () => {
    const { controller, queryRaw, queryRawUnsafe, prisma } = makeController({}, []);
    await controller.recentPayments();
    await expect(controller.consult('7d0f4f9e-0000-4000-8000-000000000001')).rejects.toThrow();
    expect(prisma.asSystem).toHaveBeenCalled();
    expect(queryRaw).toHaveBeenCalled();
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('el :paymentId de consult y consult-raw tiene que ser un UUID', () => {
    for (const method of ['consult', 'consultRaw']) {
      const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, RedsysDebugController, method) as Record<
        string,
        { pipes: unknown[] }
      >;
      const pipes = Object.values(meta).flatMap((arg) => arg.pipes);
      expect(pipes.some((p) => p === ParseUUIDPipe || p instanceof ParseUUIDPipe)).toBe(true);
    }
  });
});
