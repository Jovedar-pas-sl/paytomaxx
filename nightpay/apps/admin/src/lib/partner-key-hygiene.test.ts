import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// La clave de una plataforma se ve UNA vez: ni en el almacenamiento del
// navegador, ni en la dirección, ni en el registro de la consola, ni en
// analítica. Se lee el código de las pantallas de «Otras plataformas» y de
// su llamada al API, como texto.

const dir = new URL('../components/settings/partners/', import.meta.url);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
  .map((f) => [f, readFileSync(new URL(f, dir), 'utf8')] as const);
files.push(['endpoints/partner-connections.ts', readFileSync(new URL('./endpoints/partner-connections.ts', import.meta.url), 'utf8')]);
files.push(['partner-connections.ts', readFileSync(new URL('./partner-connections.ts', import.meta.url), 'utf8')]);

describe('la clave no se guarda en ningún sitio', () => {
  it('hay pantallas que mirar', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  for (const [name, src] of files) {
    it(`${name}: sin localStorage, sessionStorage, URL, historial, console ni analítica`, () => {
      expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
      expect(src).not.toMatch(/history\.(push|replace)State|location\.(hash|search|href)\s*=|URLSearchParams/);
      expect(src).not.toMatch(/console\.|reportClientError|Sentry|captureException|gtag|analytics/);
    });
  }

  it('la hoja de la clave la borra al cerrarse', () => {
    const sheet = readFileSync(new URL('KeyIssuedSheet.tsx', dir), 'utf8');
    expect(sheet).toMatch(/onClose/);
    const panel = readFileSync(new URL('PartnersPanel.tsx', dir), 'utf8');
    expect(panel).toMatch(/setIssued\(null\)/);
  });
});
