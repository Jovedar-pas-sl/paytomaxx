import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import {
  ArgumentsHost,
  BadRequestException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { ProblemDetailsFilter } from './problem-details.filter';
import { ZodValidationPipe } from '../pipes/zod.pipe';
import { reportError } from '../observability/sentry';

vi.mock('../observability/sentry', () => ({
  reportError: vi.fn(),
  initSentry: vi.fn(),
}));

interface CapturedResponse {
  status: number;
  body: Record<string, unknown>;
  contentType?: string;
}

function makeHost(url = '/v1/test', headers: Record<string, string> = {}): {
  host: ArgumentsHost;
  capture: CapturedResponse;
} {
  const capture: CapturedResponse = { status: 0, body: {} };
  const res = {
    status(s: number) {
      capture.status = s;
      return this;
    },
    type(t: string) {
      capture.contentType = t;
      return this;
    },
    send(b: Record<string, unknown>) {
      capture.body = b;
      return this;
    },
  };
  const req = { url, headers, id: 'req-test' };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => req,
    }),
     
  } as any;
  return { host, capture };
}

describe('ProblemDetailsFilter — production mode (D-fix)', () => {
  it('NO incluye _errStack/_errName/_excType en response para Error genérico', () => {
    const filter = new ProblemDetailsFilter(true);
    const { host, capture } = makeHost();
    filter.catch(new Error('column "foo" does not exist in BD'), host);
    expect(capture.body._errStack).toBeUndefined();
    expect(capture.body._errName).toBeUndefined();
    expect(capture.body._excType).toBeUndefined();
    expect(capture.body._errMsg).toBeUndefined();
    expect(capture.body._excDump).toBeUndefined();
    // En prod, detail genérico — NO expone el message original
    expect(capture.body.detail).toBeUndefined();
    expect(capture.body.title).toBe('Internal Server Error');
  });

  it('NO incluye _* diag para HttpException tampoco', () => {
    const filter = new ProblemDetailsFilter(true);
    const { host, capture } = makeHost();
    filter.catch(new BadRequestException('bad'), host);
    expect(capture.body._errStack).toBeUndefined();
    expect(capture.body._errName).toBeUndefined();
    expect(capture.body._excType).toBeUndefined();
  });

  it('SÍ incluye _filterVersion (deploy marker safe)', () => {
    const filter = new ProblemDetailsFilter(true);
    const { host, capture } = makeHost();
    filter.catch(new BadRequestException('x'), host);
    expect(capture.body._filterVersion).toBe('v4-prod-safe-2026-05-29');
  });

  it('SÍ incluye campos custom del HttpException body (hint, issues, etc.)', () => {
    const filter = new ProblemDetailsFilter(true);
    const { host, capture } = makeHost();
    filter.catch(
      new GoneException({
        message: 'deprecated',
        hint: 'usa /v2/foo',
        migratedAt: '2026-05-29',
      }),
      host,
    );
    // hint y migratedAt son CONTROLADOS por nuestro código → OK exponerlos
    expect(capture.body.hint).toBe('usa /v2/foo');
    expect(capture.body.migratedAt).toBe('2026-05-29');
  });
});

describe('ProblemDetailsFilter — dev mode', () => {
  it('SÍ incluye _errStack/_errName/_errMsg en response para debugging', () => {
    const filter = new ProblemDetailsFilter(false);
    const { host, capture } = makeHost();
    filter.catch(new Error('boom'), host);
    expect(capture.body._errStack).toBeDefined();
    expect(capture.body._errName).toBe('Error');
    expect(capture.body._errMsg).toBe('boom');
    expect(capture.body._excType).toBe('object');
    expect(capture.body.detail).toBe('boom');
  });

  it('expone _excDump para excepciones que NO son Error', () => {
    const filter = new ProblemDetailsFilter(false);
    const { host, capture } = makeHost();
    filter.catch({ weird: 'object' }, host);
    expect(capture.body._excDump).toBeDefined();
  });
});

describe('ProblemDetailsFilter — shape RFC 7807', () => {
  it('siempre devuelve type, status, instance', () => {
    const filter = new ProblemDetailsFilter(true);
    const { host, capture } = makeHost('/v1/payments/abc');
    filter.catch(new NotFoundException('not found'), host);
    expect(capture.body.type).toBe('about:blank');
    expect(capture.body.status).toBe(404);
    expect(capture.body.instance).toBe('/v1/payments/abc');
    expect(capture.contentType).toBe('application/problem+json');
  });

  it('respeta status code de HttpException', () => {
    const filter = new ProblemDetailsFilter(true);
    const { host, capture } = makeHost();
    filter.catch(new GoneException('gone'), host);
    expect(capture.body.status).toBe(410);
    expect(capture.status).toBe(410);
  });

  it('Error genérico siempre 500', () => {
    const filter = new ProblemDetailsFilter(true);
    const { host, capture } = makeHost();
    filter.catch(new Error('boom'), host);
    expect(capture.body.status).toBe(500);
  });

  it('errores de Fastify con statusCode 4xx (límite global, cuerpo grande…) conservan su estado', () => {
    const filter = new ProblemDetailsFilter(true);
    const { host, capture } = makeHost();
    const rateLimited = Object.assign(new Error('Rate limit exceeded, retry in 1 minute'), { statusCode: 429 });
    filter.catch(rateLimited, host);
    expect(capture.status).toBe(429);
    expect(capture.body.title).toBe('Rate limit exceeded, retry in 1 minute');

    const { host: h2, capture: c2 } = makeHost();
    filter.catch(Object.assign(new Error('fallo interno con detalles'), { statusCode: 503 }), h2);
    expect(c2.status).toBe(503);
    expect(c2.body.title).toBe('Internal Server Error');
  });
});

describe('ProblemDetailsFilter — sin secretos ni ids inventados', () => {
  it('instance sin el token de la URL', () => {
    const filter = new ProblemDetailsFilter(true);
    const { host, capture } = makeHost('/w/tok123/state?x=1');
    filter.catch(new NotFoundException(), host);
    expect(capture.body.instance).toBe('/w/***/state?x=1');
  });

  it('traceId del cliente solo si es válido; si no, el de la petición', () => {
    const filter = new ProblemDetailsFilter(true);
    const ok = makeHost('/v1/x', { 'x-trace-id': 'abc-123' });
    filter.catch(new NotFoundException(), ok.host);
    expect(ok.capture.body.traceId).toBe('abc-123');

    const malo = makeHost('/v1/x', { 'x-trace-id': '<img src=x>'.repeat(10) });
    filter.catch(new NotFoundException(), malo.host);
    expect(malo.capture.body.traceId).toBe('req-test');
  });
});

describe('ProblemDetailsFilter — el código del cuerpo es el de la respuesta', () => {
  it('un error de validación (ZodValidationPipe): HTTP 400 y "status": 400 en el cuerpo', () => {
    const filter = new ProblemDetailsFilter(true);
    const { host, capture } = makeHost();
    const err = (() => {
      try {
        new ZodValidationPipe(z.object({ amountCents: z.number().int() })).transform({ amountCents: 'diez' });
      } catch (e) {
        return e;
      }
      throw new Error('el pipe tenía que fallar');
    })();
    filter.catch(err, host);
    expect(capture.status).toBe(400);
    expect(capture.body.status).toBe(400);
    // Lo demás del cuerpo de validación sigue igual (lo leen las apps).
    expect(capture.body.title).toBe('Validation failed');
    expect(capture.body.detail).toBe('amountCents: Expected number, received string');
    expect(capture.body.issues).toBeDefined();
  });

  it('una excepción que trae otro "status", "type" o "instance" en su cuerpo no los cambia', () => {
    const filter = new ProblemDetailsFilter(true);
    const { host, capture } = makeHost('/v1/x');
    filter.catch(
      new BadRequestException({ status: 418, type: 'https://otro', instance: '/otra', message: 'mal', hint: 'ok' }),
      host,
    );
    expect(capture.status).toBe(400);
    expect(capture.body.status).toBe(400);
    expect(capture.body.type).toBe('about:blank');
    expect(capture.body.instance).toBe('/v1/x');
    expect(capture.body.hint).toBe('ok');
  });
});

describe('ProblemDetailsFilter — errores de Prisma sin los datos de la consulta (DI-08)', () => {
  const EMAIL = 'ana@example.com';
  const prismaErrors = (): Error[] => [
    new Prisma.PrismaClientKnownRequestError(
      `
Invalid \`prisma.user.create()\` invocation:

{
  data: { email: "${EMAIL}", passwordHash: "$2b$10$abc" }
}

Unique constraint failed on the fields: (\`email\`)`,
      { code: 'P2002', clientVersion: '5.22.0', meta: { modelName: 'User', target: ['email'] } },
    ),
    new Prisma.PrismaClientValidationError(`Argument \`email\`: Invalid value provided. Expected String, provided "${EMAIL}".`, {
      clientVersion: '5.22.0',
    }),
    new Prisma.PrismaClientUnknownRequestError(`Raw query failed. Key (email)=(${EMAIL}) already exists.`, {
      clientVersion: '5.22.0',
    }),
  ];

  it.each([0, 1, 2])('error %i: ni el log ni Sentry llevan los datos; sí el tipo y el código', (i) => {
    const err = prismaErrors()[i]!;
    const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.mocked(reportError).mockClear();
    const filter = new ProblemDetailsFilter(true);
    const { host, capture } = makeHost();
    filter.catch(err, host);
    expect(capture.status).toBe(500);
    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).not.toContain(EMAIL);
    expect(logged).not.toContain('$2b$10');
    expect(logged).toContain(err.name);
    if (err instanceof Prisma.PrismaClientKnownRequestError) expect(logged).toContain('P2002');
    const sent = vi.mocked(reportError).mock.calls[0]![0] as Error;
    expect(`${sent.name} ${sent.message} ${sent.stack}`).not.toContain(EMAIL);
    expect(sent.name).toBe(err.name);
    logError.mockRestore();
  });

  it('el resto de errores se loguean como siempre (con su mensaje)', () => {
    const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    new ProblemDetailsFilter(true).catch(new Error('fallo de verdad 42'), makeHost().host);
    expect(JSON.stringify(logError.mock.calls)).toContain('fallo de verdad 42');
    logError.mockRestore();
  });
});
