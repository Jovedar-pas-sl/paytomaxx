import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { PARTNER_CONNECTION_EXAMPLE, PARTNER_ROUTES, buildPartnerOpenApi, type PartnerRouteDef } from '@nightpay/contracts';
import { PARTNER_ROUTE } from './partner-route.decorator';
import { toPartnerError } from './partner-problem';
import { PartnerResponseInterceptor } from './partner-response.interceptor';

function setup(def: PartnerRouteDef, headers: Record<string, string> = {}) {
  const handler = () => undefined;
  Reflect.defineMetadata(PARTNER_ROUTE, def, handler);
  const reply = { header: vi.fn() };
  const ctx = {
    getHandler: () => handler,
    getClass: () => Object,
    switchToHttp: () => ({ getRequest: () => ({ headers, url: '/v1/partner/me' }), getResponse: () => reply }),
  };
  const run = (body: unknown) =>
    lastValueFrom(new PartnerResponseInterceptor(new Reflector()).intercept(ctx as never, { handle: () => of(body) }));
  return { reply, run };
}

const example = JSON.parse(JSON.stringify(PARTNER_CONNECTION_EXAMPLE.value)) as Record<string, unknown>;

describe('PartnerResponseInterceptor', () => {
  it('pasa la respuesta por su esquema: lo que sobra (ids internos, hashes) no sale', async () => {
    const { run } = setup(PARTNER_ROUTES.getConnection);
    const leaky = {
      ...example,
      tenantId: 'aaaaaaaa-0000-0000-0000-000000000001',
      keyHash: 'f'.repeat(64),
      issuer: { ...(example.issuer as object), businessId: 'x' },
      key: { ...(example.key as object), hash: 'f'.repeat(64) },
    };
    expect(await run(leaky)).toEqual(example);
  });

  it('pone Request-Id (el X-Request-Id válido) y Cache-Control: no-store', async () => {
    const { run, reply } = setup(PARTNER_ROUTES.getConnection, { 'x-request-id': 'atm0042-req-000731-1' });
    await run(example);
    expect(reply.header).toHaveBeenCalledWith('Request-Id', 'atm0042-req-000731-1');
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'no-store');
    const other = setup(PARTNER_ROUTES.getConnection, { 'x-request-id': 'con espacios' });
    await other.run(example);
    expect(other.reply.header).toHaveBeenCalledWith('Request-Id', expect.stringMatching(/^[0-9a-f-]{36}$/));
  });

  it('openapi.json sale entero', async () => {
    const { run } = setup(PARTNER_ROUTES.getOpenApi);
    const doc = buildPartnerOpenApi();
    expect(await run(doc)).toEqual(doc);
  });

  it('una respuesta que no cumple su esquema no sale: 500 internal_error', async () => {
    const { run } = setup(PARTNER_ROUTES.getConnection);
    const err = await run({ ...example, livemode: 'sí' }).catch((e: unknown) => e);
    expect(toPartnerError(err).code).toBe('internal_error');
  });
});
