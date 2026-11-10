import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_BACKGROUND, APP_ICONS, appManifest, appleAppMetadata } from '@nightpay/ui/app-manifest';

const APPS = join(__dirname, '..', '..', '..');

describe('se abre como app desde la pantalla de inicio (manifiesto)', () => {
  it('a pantalla completa, desde la raíz y con el fondo de Grafito', () => {
    const m = appManifest({ name: 'OxioPay — Personal', shortName: 'OxioPay', description: 'x' });
    expect(m).toMatchObject({ display: 'standalone', start_url: '/', scope: '/', orientation: 'portrait', lang: 'es' });
    expect(m.background_color).toBe(APP_BACKGROUND);
    expect(m.theme_color).toBe(APP_BACKGROUND);
    // El mismo fondo que la app: al abrirla no sale un destello de otro color.
    expect(readFileSync(join(APPS, '..', 'packages', 'ui', 'src', 'styles.css'), 'utf8').toLowerCase()).toContain(`--np-bg: ${APP_BACKGROUND}`);
    expect(m.icons.map((i) => i.sizes)).toEqual(['192x192', '512x512', '512x512']);
    expect(m.icons.some((i) => 'purpose' in i && i.purpose === 'maskable')).toBe(true);
  });

  it('en el iPhone: icono propio y abrir como app', () => {
    const meta = appleAppMetadata('OxioPay');
    expect(meta.appleWebApp).toEqual({ capable: true, title: 'OxioPay', statusBarStyle: 'black' });
    expect(meta.icons.apple[0]!.url).toBe(APP_ICONS.apple);
  });

  it('girar: el personal, en vertical (el móvil en la mano); el TPV y el panel, como esté la pantalla', () => {
    const orientation = (app: string) => readFileSync(join(APPS, app, 'src', 'app', 'manifest.ts'), 'utf8').match(/orientation: '(\w+)'/)?.[1];
    expect(orientation('operator')).toBe('portrait');
    expect(orientation('tpv')).toBe('any');
    expect(orientation('admin')).toBe('any');
  });

  it.each(['operator', 'admin', 'tpv'])('%s: los iconos están en public/ y la app enlaza el manifiesto', (app) => {
    for (const path of Object.values(APP_ICONS)) expect(existsSync(join(APPS, app, 'public', path))).toBe(true);
    expect(existsSync(join(APPS, app, 'src', 'app', 'manifest.ts'))).toBe(true);
    expect(readFileSync(join(APPS, app, 'src', 'app', 'layout.tsx'), 'utf8')).toContain('appleAppMetadata(');
  });
});
