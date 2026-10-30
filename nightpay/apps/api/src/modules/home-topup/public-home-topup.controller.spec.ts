import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { IP_RATE_LIMIT_META } from '../../common/guards/ip-rate-limit.guard';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { PublicHomeTopUpController } from './public-home-topup.controller';
import { HOME_TOPUP_PAGE_LIMIT, HOME_TOPUP_START_LIMIT } from './home-topup-rules';
import type { HomeTopUpPageView } from './home-topup.service';

const CODE = 'AbCdEfGhIjKlMnOp';
const view: HomeTopUpPageView = {
  venueName: 'Sala Aurora',
  problem: null,
  presetsCents: [2000, 5000, 10000],
  minCents: 1000,
  maxCents: 30000,
  serviceFeeBps: null,
  feesCents: null,
  mine: null,
};

/** Una respuesta de Fastify de mentira: guarda estado, cabeceras y cuerpo. */
function reply() {
  const out = { status: 0, headers: {} as Record<string, string[]>, body: '' as unknown };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    header(name: string, value: string) {
      (out.headers[name.toLowerCase()] ??= []).push(value);
      return res;
    },
    send(body?: unknown) {
      out.body = body;
      return res;
    },
  };
  return { res, out };
}

function make(o: { page?: HomeTopUpPageView | null; href?: string | null } = {}) {
  const homeTopUps = {
    page: vi.fn(async () => (o.page === undefined ? view : o.page)),
    mySaldoHref: vi.fn(async () => o.href ?? null),
    start: vi.fn(async () => ({ payToken: 'payTok', payUrl: '/pay/payTok?lang=fr' })),
  };
  return { controller: new PublicHomeTopUpController(homeTopUps as never), homeTopUps };
}

describe('PublicHomeTopUpController (/r/:code)', () => {
  it('la página: 200, sin caché, sin referer y en el idioma pedido (que se recuerda)', async () => {
    const { controller, homeTopUps } = make();
    const { res, out } = reply();
    await controller.page(CODE, 'pt', 'np_saldos=x', res as never);
    expect(homeTopUps.page).toHaveBeenCalledWith(CODE, 'np_saldos=x');
    expect(out.status).toBe(200);
    expect(out.headers['cache-control']).toEqual(['no-store']);
    expect(out.headers['referrer-policy']).toEqual(['no-referrer']);
    expect(out.headers['set-cookie']?.[0]).toContain('np_lang=pt');
    expect(String(out.body)).toContain('<html lang="pt">');
  });

  it('apagado, código cambiado o sin forma: 404 con la misma página sin pistas', async () => {
    const { controller } = make({ page: null });
    const { res, out } = reply();
    await controller.page('LoQueSea0123456z', undefined, undefined, res as never);
    expect(out.status).toBe(404);
    expect(String(out.body)).toContain('Este enlace no vale');
    expect(String(out.body)).not.toContain('Sala');
  });

  it('«Recargar mi saldo»: 303 a su página del saldo; sin saldo que recuerde, de vuelta al enlace', async () => {
    const yes = make({ href: '/w/q2?lang=es#recargar' });
    const a = reply();
    await yes.controller.mySaldo(CODE, 'es', 'np_saldos=x', a.res as never);
    expect(a.out.status).toBe(303);
    expect(a.out.headers.location).toEqual(['/w/q2?lang=es#recargar']);
    const no = make({ href: null });
    const b = reply();
    await no.controller.mySaldo(CODE, undefined, undefined, b.res as never);
    expect(b.out.headers.location).toEqual([`/r/${CODE}?lang=es`]);
  });

  it('«Cargar»: crea la carga y devuelve solo a dónde ir a pagar', async () => {
    const { controller, homeTopUps } = make();
    await expect(controller.start(CODE, { amountCents: 5000, key: 'k1234567890abcdef', lang: 'fr' }, undefined)).resolves.toEqual({
      payUrl: '/pay/payTok?lang=fr',
    });
    expect(homeTopUps.start).toHaveBeenCalledWith(CODE, { amountCents: 5000, key: 'k1234567890abcdef', lang: 'fr' });
  });

  it('públicas y con su freno por IP (y por IP y local al cargar)', () => {
    const proto = PublicHomeTopUpController.prototype as unknown as Record<string, () => void>;
    for (const name of ['page', 'mySaldo', 'start']) expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto[name])).toBe(true);
    expect(Reflect.getMetadata(IP_RATE_LIMIT_META, proto.page)).toEqual(HOME_TOPUP_PAGE_LIMIT);
    expect(Reflect.getMetadata(IP_RATE_LIMIT_META, proto.start)).toEqual(HOME_TOPUP_START_LIMIT);
  });
});
