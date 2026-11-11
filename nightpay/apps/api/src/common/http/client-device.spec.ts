import { describe, expect, it } from 'vitest';
import { deviceLabel } from '@nightpay/contracts';
import { browserFromBrands, describeClientDevice, deviceHeadersOf, hintString } from './client-device';

const IPHONE_SAFARI_18 =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const ANDROID_REDUCED =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const ANDROID_FACEBOOK =
  'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/470.0.0.40.94;]';
const IPHONE_INSTAGRAM =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 337.0.3.23.54 (iPhone15,2; iOS 17_5; es_ES; es)';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1';
const SAMSUNG_INTERNET =
  'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36';
const WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

describe('describeClientDevice: el móvil de quien paga o cobra', () => {
  it('un iPhone no da el modelo: queda «iPhone · iOS 18»', () => {
    const d = describeClientDevice({ 'user-agent': IPHONE_SAFARI_18 });
    expect(d).toEqual({ model: 'iPhone', os: 'iOS', osVersion: '18', browser: 'Safari 18', mobile: true, inApp: null });
    expect(deviceLabel(d)).toBe('iPhone · iOS 18 · Safari 18');
  });

  it('Android con el User-Agent recortado y sin client hints: ni modelo ni versión (los de ese texto no son de verdad)', () => {
    expect(describeClientDevice({ 'user-agent': ANDROID_REDUCED })).toEqual({
      model: null,
      os: 'Android',
      osVersion: null,
      browser: 'Chrome 130',
      mobile: true,
      inApp: null,
    });
  });

  it('Android con client hints: el modelo y la versión de verdad', () => {
    const d = describeClientDevice({
      'user-agent': ANDROID_REDUCED,
      'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
      'sec-ch-ua-mobile': '?1',
      'sec-ch-ua-platform': '"Android"',
      'sec-ch-ua-model': '"SM-S918B"',
      'sec-ch-ua-platform-version': '"14.0.0"',
    });
    expect(d).toMatchObject({ model: 'SM-S918B', os: 'Android', osVersion: '14', browser: 'Chrome 130', mobile: true });
    expect(deviceLabel(d)).toBe('SM-S918B · Android 14 · Chrome 130');
  });

  it('el navegador de otra app (Facebook, Instagram): se dice dentro de cuál', () => {
    const fb = describeClientDevice({ 'user-agent': ANDROID_FACEBOOK });
    expect(fb).toMatchObject({ model: 'SM-S911B', os: 'Android', osVersion: '13', inApp: 'Facebook' });
    const ig = describeClientDevice({ 'user-agent': IPHONE_INSTAGRAM });
    expect(ig).toMatchObject({ model: 'iPhone', osVersion: '17', browser: null, inApp: 'Instagram' });
    expect(deviceLabel(ig)).toBe('iPhone · iOS 17 · dentro de Instagram');
  });

  it('Chrome del iPhone, Samsung Internet, Windows y Mac', () => {
    expect(describeClientDevice({ 'user-agent': IPHONE_CHROME })).toMatchObject({ model: 'iPhone', browser: 'Chrome 130' });
    expect(describeClientDevice({ 'user-agent': SAMSUNG_INTERNET })).toMatchObject({
      model: 'SAMSUNG SM-A546B',
      osVersion: '14',
      browser: 'Samsung Internet 24',
    });
    expect(describeClientDevice({ 'user-agent': WINDOWS_CHROME })).toMatchObject({ os: 'Windows', browser: 'Chrome 126', mobile: false });
    expect(describeClientDevice({ 'user-agent': MAC_SAFARI })).toMatchObject({ model: null, os: 'macOS', browser: 'Safari 17' });
  });

  it('sin cabeceras: no se sabe nada (y no falla)', () => {
    const d = describeClientDevice({});
    expect(d).toEqual({ model: null, os: null, osVersion: null, browser: null, mobile: null, inApp: null });
    expect(deviceLabel(d)).toBe('Dispositivo sin identificar');
  });

  it('un modelo con caracteres raros se limpia y se recorta (nunca llega tal cual a una página)', () => {
    const d = describeClientDevice({ 'user-agent': ANDROID_REDUCED, 'sec-ch-ua-model': `"<script>alert(1)</script>${'x'.repeat(80)}"` });
    expect(d.model).not.toMatch(/[<>"]/);
    expect(d.model!.length).toBeLessThanOrEqual(40);
  });

  it('cabeceras repetidas: vale la primera', () => {
    expect(describeClientDevice({ 'user-agent': [IPHONE_SAFARI_18, WINDOWS_CHROME] })).toMatchObject({ model: 'iPhone' });
  });
});

describe('client hints sueltos', () => {
  it('la marca de Sec-CH-UA: la de verdad, sin la de relleno ni Chromium', () => {
    expect(browserFromBrands('"Not_A Brand";v="8", "Chromium";v="120", "Microsoft Edge";v="120"')).toBe('Edge 120');
    expect(browserFromBrands('"Chromium";v="120", "Not?A_Brand";v="24"')).toBe('Chromium 120');
    expect(browserFromBrands(null)).toBeNull();
  });

  it('un texto vacío es nada', () => {
    expect(hintString('""')).toBeNull();
    expect(hintString(null)).toBeNull();
  });

  it('del contexto solo se guardan las cabeceras del dispositivo', () => {
    expect(
      deviceHeadersOf({ 'user-agent': 'x', authorization: 'Bearer secreto', cookie: 'a=b', 'sec-ch-ua-model': '"Pixel 8"' }),
    ).toEqual({ 'user-agent': 'x', 'sec-ch-ua-model': '"Pixel 8"' });
    expect(deviceHeadersOf(undefined)).toEqual({});
  });
});
