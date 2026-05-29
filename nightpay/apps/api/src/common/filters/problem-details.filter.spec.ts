import { describe, it, expect, vi } from 'vitest';
import {
  ArgumentsHost,
  BadRequestException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { ProblemDetailsFilter } from './problem-details.filter';

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
});
