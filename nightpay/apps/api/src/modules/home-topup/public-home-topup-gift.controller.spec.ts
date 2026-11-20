import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { IP_RATE_LIMIT_META } from '../../common/guards/ip-rate-limit.guard';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { PublicHomeTopUpGiftController } from './public-home-topup-gift.controller';
import { HOME_TOPUP_PAGE_LIMIT, HOME_TOPUP_START_LIMIT } from './home-topup-rules';
import { GIFT_CLAIM_LIMIT, GIFT_LEGAL_TEXT } from './home-topup-gift';
import type { GiftPageView } from './home-topup-gift-page';
import { renderHomeTopUpPage } from './home-topup-page';
import type { HomeTopUpPageView } from './home-topup.service';
import type { GiftClaim } from './home-topup-gift.service';

const CODE = 'AbCdEfGhIjKlMnOp';
const NBSP = String.fromCharCode(0xa0);
const TOKEN = 'Tok_en-0123456789abcdefghijklmnop'.slice(0, 32);
const giftView: GiftPageView = {
  state: 'open',
  venueName: 'Sala <Aurora>',
  amountCents: 5000,
  toName: 'Ana <b>',
  message: 'Mira https://evil.example/x <script>alert(1)</script>',
  expiresAt: new Date('2027-02-17T21:00:00.000Z'),
};

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

function make(o: { view?: GiftPageView | null; claim?: GiftClaim | null } = {}) {
  const homeTopUps = { start: vi.fn(async () => ({ payToken: 'payTok', payUrl: '/pay/payTok?lang=es' })) };
  const gifts = {
    origin: 'https://api.sala.test',
    view: vi.fn(async () => (o.view === undefined ? giftView : o.view)),
    claim: vi.fn(async () => (o.claim === undefined ? { activationPath: '/w/a/ActivAtion0123456789abcdefghijk' } : o.claim)),
  };
  return { controller: new PublicHomeTopUpGiftController(homeTopUps as never, gifts as never), homeTopUps, gifts };
}

async function page(o: Parameters<typeof make>[0], bought?: string, lang = 'es') {
  const m = make(o);
  const { res, out } = reply();
  await m.controller.page(TOKEN, lang, bought, undefined, res as never);
  return { ...out, html: String(out.body) };
}

describe('PublicHomeTopUpGiftController («Regala una noche»)', () => {
  it('públicas y con el freno por IP de /r: comprar como «Cargar», la página como la del enlace, guardar más estricto', () => {
    const proto = PublicHomeTopUpGiftController.prototype as unknown as Record<string, () => void>;
    for (const name of ['start', 'page', 'claim']) expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto[name])).toBe(true);
    expect(Reflect.getMetadata(IP_RATE_LIMIT_META, proto.start)).toEqual(HOME_TOPUP_START_LIMIT);
    expect(Reflect.getMetadata(IP_RATE_LIMIT_META, proto.page)).toEqual(HOME_TOPUP_PAGE_LIMIT);
    expect(Reflect.getMetadata(IP_RATE_LIMIT_META, proto.claim)).toEqual(GIFT_CLAIM_LIMIT);
    expect(GIFT_CLAIM_LIMIT).toMatchObject({ max: 20, windowSec: 900, perKey: { param: 'token', max: 10 } });
  });

  it('comprar: la carga de siempre con el nombre y el mensaje; solo dice a dónde ir a pagar', async () => {
    const { controller, homeTopUps } = make();
    const req = { headers: {}, raw: { socket: { remoteAddress: '203.0.113.7' } } };
    const out = await controller.start(CODE, { amountCents: 5000, key: 'k1234567890abcdef', lang: 'pt', name: 'Ana', message: 'Hola' }, undefined, req as never);
    expect(out).toEqual({ payUrl: '/pay/payTok?lang=es' });
    expect(homeTopUps.start).toHaveBeenCalledWith(CODE, {
      amountCents: 5000,
      key: 'k1234567890abcdef',
      lang: 'pt',
      ip: '203.0.113.7',
      gift: { name: 'Ana', message: 'Hola' },
    });
  });

  it('no existe, sin pagar o de un local cerrado: 404 con «Este enlace no vale», sin pistas', async () => {
    const out = await page({ view: null });
    expect(out.status).toBe(404);
    expect(out.html).toContain('Este enlace no vale');
    expect(out.html).not.toContain('Sala');
  });

  it('quien lo recibe: cuánto y dónde, su nombre y el mensaje escapados (ningún enlace pintado) y «Guardar en mi móvil»', async () => {
    const out = await page({});
    expect(out.status).toBe(200);
    expect(out.headers['cache-control']).toEqual(['no-store']);
    expect(out.headers['referrer-policy']).toEqual(['no-referrer']);
    const html = out.html.split(NBSP).join(' ');
    expect(html).toContain('Te han regalado 50 € en Sala &lt;Aurora&gt;');
    expect(html).toContain('Para Ana &lt;b&gt;');
    expect(html).toContain('Mira https://evil.example/x &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('href="https://evil');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain(`<form method="post" action="/r/regalo/${TOKEN}/guardar?lang=es">`);
    expect(html).toContain('Guardar en mi móvil');
    expect(html).toContain('Guárdalo antes del 17 de febrero de 2027.');
    // Ni el enlace para compartir ni nada del saldo.
    expect(html).not.toContain('wa.me');
    expect(html).not.toContain('/w/');
  });

  it('quien lo pagó (?comprado=1): «Comparte tu regalo», WhatsApp, copiar y las condiciones del abogado; sin «Guardar»', async () => {
    const out = await page({}, '1');
    const html = out.html;
    expect(html).toContain('Comparte tu regalo');
    expect(html).toContain(`value="https://api.sala.test/r/regalo/${TOKEN}"`);
    const wa = /href="(https:\/\/wa\.me\/\?text=[^"]+)"/.exec(html)?.[1];
    expect(decodeURIComponent(wa!.slice('https://wa.me/?text='.length).replace(/&amp;/g, '&')).split(NBSP).join(' ')).toBe(
      `Te he regalado 50 € para Sala <Aurora>: https://api.sala.test/r/regalo/${TOKEN}`,
    );
    expect(html).toContain('id="gCopy"');
    expect(html).toContain(GIFT_LEGAL_TEXT.es.notRefundable);
    expect(html).toContain('Si nadie lo guarda en 90 días, el enlace del regalo deja de valer.');
    expect(html).not.toContain('/guardar');
    // El idioma se cambia sin perder «Comparte tu regalo».
    expect(html).toContain(`/r/regalo/${TOKEN}?comprado=1&amp;lang=en`);
    for (const part of html.split('<script>').slice(1)) {
      expect(() => new Function(part.slice(0, part.indexOf('</script>')))).not.toThrow();
    }
  });

  it('ya guardado: «Este regalo ya se ha guardado» para todos (también para quien lo pagó), sin nada que guardar ni compartir', async () => {
    for (const bought of [undefined, '1']) {
      const html = (await page({ view: { ...giftView, state: 'claimed' } }, bought)).html;
      expect(html).toContain('Este regalo ya se ha guardado');
      expect(html).not.toContain('/guardar');
      expect(html).not.toContain('wa.me');
      expect(html).not.toContain('Ana');
      expect(html).not.toContain('evil');
    }
  });

  it('caducado: lo dice y no deja guardarlo; en los cuatro idiomas', async () => {
    expect((await page({ view: { ...giftView, state: 'expired' } })).html).toContain('Este regalo ha caducado');
    expect((await page({ view: { ...giftView, state: 'expired' } }, undefined, 'en')).html).toContain('This gift has expired');
    expect((await page({}, undefined, 'fr')).html).toContain('Enregistrer sur mon téléphone');
    expect((await page({}, undefined, 'pt')).html).toContain('Guardar no meu telemóvel');
  });

  it('«Guardar en mi móvil»: 303 al QR de activación de siempre; ya guardado o caducado, a la página; sin regalo, 404', async () => {
    const ok = make();
    const a = reply();
    await ok.controller.claim(TOKEN, 'fr', undefined, a.res as never);
    expect(a.out.status).toBe(303);
    expect(a.out.headers.location).toEqual(['/w/a/ActivAtion0123456789abcdefghijk?lang=fr']);
    expect(a.out.headers['cache-control']).toEqual(['no-store']);
    const done = make({ claim: { state: 'claimed' } });
    const b = reply();
    await done.controller.claim(TOKEN, 'es', undefined, b.res as never);
    expect(b.out.headers.location).toEqual([`/r/regalo/${TOKEN}?lang=es`]);
    const none = make({ claim: null });
    const c = reply();
    await none.controller.claim(TOKEN, 'es', undefined, c.res as never);
    expect(c.out.status).toBe(404);
  });
});

describe('/r/<código> con «Regalos»', () => {
  const view: HomeTopUpPageView = {
    venueName: 'Sala Aurora',
    problem: null,
    presetsCents: [2000, 5000, 10000],
    minCents: 1000,
    maxCents: 30000,
    serviceFeeBps: null,
    feesCents: null,
    mine: { codeHint: 'K7Q-•••' },
  };

  it('apagado: ni la elección ni el modo regalo (aunque llegue ?regalo=1)', () => {
    for (const mode of ['load', 'gift'] as const) {
      const html = renderHomeTopUpPage(CODE, 'es', view, mode);
      expect(html).not.toContain('Para regalar');
      expect(html).not.toContain('id="gName"');
      expect(html).not.toContain('\\"gift\\":true');
      expect(html).toContain('Carga tu saldo para');
    }
  });

  it('encendido: «Para mí» / «Para regalar»; la carga de siempre sigue igual', () => {
    const html = renderHomeTopUpPage(CODE, 'es', { ...view, gifts: true });
    expect(html).toContain(`<a href="/r/${CODE}?lang=es" aria-current="page">Para mí</a>`);
    expect(html).toContain(`<a href="/r/${CODE}?lang=es&amp;regalo=1">Para regalar</a>`);
    expect(html).toContain('Recargar mi saldo');
    expect(html).not.toContain('id="gName"');
  });

  it('«Para regalar»: 25, 50 (marcado) y 100 €, «Otro», su nombre y un mensaje, las condiciones, y va por /regalo; JS válido', () => {
    const html = renderHomeTopUpPage(CODE, 'es', { ...view, gifts: true, queue: { token: '20.abc' } }, 'gift');
    expect(html).toContain('Regala saldo para <span>Sala Aurora</span>');
    expect(html).toContain('value="2500"');
    expect(html).toContain('value="5000" checked');
    expect(html).toContain('value="10000"');
    expect(html).not.toContain('value="2000"');
    expect(html).toContain('value="other"');
    expect(html).toContain('<input id="gName" type="text" maxlength="40"');
    expect(html).toContain('<textarea id="gMsg" rows="2" maxlength="120">');
    expect(html).toContain('El regalo solo vale en Sala Aurora.');
    expect(html).toContain(GIFT_LEGAL_TEXT.es.notRefundable);
    expect(html).toContain("pkPost(C.base+'/regalo'");
    expect(html).toContain('\\"gift\\":true');
    // Sin «Recargar mi saldo» ni el cartel de la cola.
    expect(html).not.toContain('Recargar mi saldo');
    expect(html).not.toContain('20.abc');
    expect(html).toContain(`aria-current="page">Para regalar</a>`);
    for (const part of html.split('<script>').slice(1)) {
      expect(() => new Function(part.slice(0, part.indexOf('</script>')))).not.toThrow();
    }
  });
});
