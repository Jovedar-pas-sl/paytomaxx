import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, type CanActivate, type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ProblemDetailsFilter } from '../../common/filters/problem-details.filter';
import { PartyRefundsController } from './party-refunds.controller';
import { PartyRefundsService } from './party-refunds.service';
import { NO_DEBTOR_IBAN_CODE, NO_DEBTOR_IBAN_MESSAGE } from './sepa';

/**
 * GET /v1/admin/party/refunds/transferencias.sepa por HTTP: solo dueño y
 * encargado (el resto, 403), el XML como descarga sin caché, el 409 del API
 * tal cual y, con OxioPay (EDITION=club), 404.
 */

const URL = '/v1/admin/party/refunds/transferencias.sepa';
const XML = '<?xml version="1.0" encoding="UTF-8"?><Document/>';
const refunds = { transfersSepa: vi.fn() };

/** El AuthGuard de verdad lee el JWT; aquí, el rol de la cabecera (sin cabecera: sin sesión). */
class FakeAuth implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const role = req.headers['x-test-role'];
    if (!role) throw new UnauthorizedException();
    req.user = { sub: 'u-1', tenantId: 'venue-1', role, email: 'org@fiesta.es' };
    return true;
  }
}

let app: NestFastifyApplication;
beforeAll(async () => {
  const ref = await Test.createTestingModule({
    controllers: [PartyRefundsController],
    providers: [
      { provide: PartyRefundsService, useValue: refunds },
      { provide: APP_GUARD, useClass: FakeAuth },
    ],
  }).compile();
  app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new ProblemDetailsFilter(false));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  vi.stubEnv('EDITION', 'party');
  refunds.transfersSepa.mockReset().mockResolvedValue({ xml: XML, messageId: 'OXPD1', count: 2, totalCents: 1734 });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /v1/admin/party/refunds/transferencias.sepa', () => {
  it.each(['OWNER', 'MANAGER'])('%s: el XML como descarga, sin caché, y con quién lo pide', async (role) => {
    const res = await app.inject({ method: 'GET', url: URL, headers: { 'x-test-role': role } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(XML);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="transferencias-pendientes-\d{4}-\d{2}-\d{2}\.xml"$/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(refunds.transfersSepa).toHaveBeenCalledWith({ userId: 'u-1', role, tenantId: 'venue-1', email: 'org@fiesta.es' }, expect.any(Date), { again: false });
  });

  it('ya descargado: el 409 ALREADY_EXPORTED con cuándo y quién; con ?again=1, el fichero otra vez', async () => {
    refunds.transfersSepa.mockRejectedValueOnce(
      new ConflictException({ code: 'ALREADY_EXPORTED', message: 'Este fichero ya se descargó', exportedAt: '2027-06-29T19:30:00.000Z', exportedBy: 'Paco' }),
    );
    const first = await app.inject({ method: 'GET', url: URL, headers: { 'x-test-role': 'OWNER' } });
    expect(first.statusCode).toBe(409);
    expect(first.json()).toMatchObject({ code: 'ALREADY_EXPORTED', exportedAt: '2027-06-29T19:30:00.000Z', exportedBy: 'Paco' });
    const again = await app.inject({ method: 'GET', url: `${URL}?again=1`, headers: { 'x-test-role': 'OWNER' } });
    expect(again.statusCode).toBe(200);
    expect(refunds.transfersSepa).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'u-1' }), expect.any(Date), { again: true });
  });

  it.each(['WAITER', 'OPERATOR'])('%s: 403 y no se hace nada', async (role) => {
    const res = await app.inject({ method: 'GET', url: URL, headers: { 'x-test-role': role } });
    expect(res.statusCode).toBe(403);
    expect(refunds.transfersSepa).not.toHaveBeenCalled();
  });

  it('sin la cuenta del local: el 409 NO_DEBTOR_IBAN del servicio, tal cual', async () => {
    refunds.transfersSepa.mockRejectedValueOnce(new ConflictException({ code: NO_DEBTOR_IBAN_CODE, message: NO_DEBTOR_IBAN_MESSAGE }));
    const res = await app.inject({ method: 'GET', url: URL, headers: { 'x-test-role': 'OWNER' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: NO_DEBTOR_IBAN_CODE });
  });

  it('con OxioPay (EDITION=club), 404', async () => {
    vi.stubEnv('EDITION', 'club');
    const res = await app.inject({ method: 'GET', url: URL, headers: { 'x-test-role': 'OWNER' } });
    expect(res.statusCode).toBe(404);
    expect(refunds.transfersSepa).not.toHaveBeenCalled();
  });
});
