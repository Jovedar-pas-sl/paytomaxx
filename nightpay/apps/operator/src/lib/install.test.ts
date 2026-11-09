import { describe, expect, it } from 'vitest';
import { INSTALL_SNOOZE_MS, installPlatform, installSnoozed, snoozeInstall } from '@nightpay/ui';

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1';
const IPHONE_INSTAGRAM = `${IPHONE_SAFARI} Instagram 300.0`;
const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36';

describe('instalar como app: qué se ofrece en cada móvil', () => {
  it('ya instalada: nada', () => {
    expect(installPlatform({ userAgent: IPHONE_SAFARI, standalone: true, hasPrompt: false })).toBe('installed');
    expect(installPlatform({ userAgent: ANDROID, standalone: true, hasPrompt: true })).toBe('installed');
  });

  it('Android/Chrome con su aviso: el botón «Instalar»', () => {
    expect(installPlatform({ userAgent: ANDROID, standalone: false, hasPrompt: true })).toBe('prompt');
  });

  it('iPhone e iPad en Safari: los pasos (el iPhone no avisa solo)', () => {
    expect(installPlatform({ userAgent: IPHONE_SAFARI, standalone: false, hasPrompt: false })).toBe('ios');
    expect(installPlatform({ userAgent: IPAD_DESKTOP_UA, standalone: false, hasPrompt: false })).toBe('ios');
  });

  it('Chrome del iPhone, navegadores dentro de otras apps o Android sin aviso: no se ofrece', () => {
    expect(installPlatform({ userAgent: IPHONE_CHROME, standalone: false, hasPrompt: false })).toBe('none');
    expect(installPlatform({ userAgent: IPHONE_INSTAGRAM, standalone: false, hasPrompt: false })).toBe('none');
    expect(installPlatform({ userAgent: ANDROID, standalone: false, hasPrompt: false })).toBe('none');
  });

  it('«Ahora no»: 30 días sin volver a ofrecerlo; sin almacenamiento no molesta', () => {
    let stored: string | null = null;
    snoozeInstall(1_000, (v) => (stored = v));
    expect(installSnoozed(1_000 + INSTALL_SNOOZE_MS - 1, () => stored)).toBe(true);
    expect(installSnoozed(1_000 + INSTALL_SNOOZE_MS + 1, () => stored)).toBe(false);
    expect(installSnoozed(5, () => null)).toBe(false);
    expect(
      installSnoozed(5, () => {
        throw new Error('modo privado');
      }),
    ).toBe(true);
    expect(() =>
      snoozeInstall(5, () => {
        throw new Error('lleno');
      }),
    ).not.toThrow();
  });
});
