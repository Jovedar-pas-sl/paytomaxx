import { describe, it, expect } from 'vitest';
import { detectPayDevice } from './pay-device';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const IPHONE_INSTAGRAM =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 337.0.3.23.54 (iPhone15,2; iOS 17_5; es_ES; es)';
const ANDROID_FACEBOOK =
  'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/470.0.0.40.94;]';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

describe('detectPayDevice', () => {
  it('iPhone → Apple Pay', () => {
    expect(detectPayDevice(IPHONE_SAFARI)).toEqual({ wallet: 'Apple Pay', inApp: null });
  });

  it('Android → Google Pay', () => {
    expect(detectPayDevice(ANDROID_CHROME)).toEqual({ wallet: 'Google Pay', inApp: null });
  });

  it('navegador de Instagram → sin wallet y con aviso', () => {
    expect(detectPayDevice(IPHONE_INSTAGRAM)).toEqual({ wallet: null, inApp: 'Instagram' });
  });

  it('navegador de Facebook en Android → sin wallet y con aviso', () => {
    expect(detectPayDevice(ANDROID_FACEBOOK)).toEqual({ wallet: null, inApp: 'Facebook' });
  });

  it('Safari de Mac → Apple Pay; Chrome de Windows → solo tarjeta', () => {
    expect(detectPayDevice(MAC_SAFARI).wallet).toBe('Apple Pay');
    expect(detectPayDevice(WINDOWS_CHROME)).toEqual({ wallet: null, inApp: null });
  });

  it('sin User-Agent → solo tarjeta', () => {
    expect(detectPayDevice(undefined)).toEqual({ wallet: null, inApp: null });
  });
});
