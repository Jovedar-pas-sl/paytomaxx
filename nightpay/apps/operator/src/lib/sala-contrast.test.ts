import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SALA_ATTR, SALA_INIT_SCRIPT, SALA_STORAGE_KEY, applySalaContrast } from './sala-contrast';

function fakeRoot() {
  const attrs = new Map<string, string>();
  return {
    attrs,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
  };
}

function fakeStorage() {
  const items = new Map<string, string>();
  return {
    items,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
    getItem: (k: string) => items.get(k) ?? null,
  };
}

describe('modo «sala» en la app del personal (decisión D9)', () => {
  it('encendido: <html data-contrast="sala"> y este móvil lo recuerda', () => {
    const root = fakeRoot();
    const storage = fakeStorage();
    applySalaContrast(root, storage, true);
    expect(root.attrs.get(SALA_ATTR)).toBe('sala');
    expect(storage.items.get(SALA_STORAGE_KEY)).toBe('sala');
  });

  it('apagado: se quita y se olvida', () => {
    const root = fakeRoot();
    const storage = fakeStorage();
    applySalaContrast(root, storage, true);
    applySalaContrast(root, storage, false);
    expect(root.attrs.has(SALA_ATTR)).toBe(false);
    expect(storage.items.has(SALA_STORAGE_KEY)).toBe(false);
  });

  it('sin almacenamiento (navegación privada) se aplica igual', () => {
    const root = fakeRoot();
    const broken = {
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
      removeItem: () => undefined,
    };
    expect(() => applySalaContrast(root, broken, true)).not.toThrow();
    expect(root.attrs.get(SALA_ATTR)).toBe('sala');
    applySalaContrast(root, null, false);
    expect(root.attrs.has(SALA_ATTR)).toBe(false);
  });

  it('el script del layout lo pone antes de pintar si este móvil lo recuerda', () => {
    const run = (stored: string | null) => {
      const root = fakeRoot();
      const storage = fakeStorage();
      if (stored) storage.setItem(SALA_STORAGE_KEY, stored);
      new Function('localStorage', 'document', SALA_INIT_SCRIPT)(storage, { documentElement: root });
      return root.attrs.get(SALA_ATTR) ?? null;
    };
    expect(run('sala')).toBe('sala');
    expect(run(null)).toBeNull();
    expect(run('otra')).toBeNull();
    expect(SALA_INIT_SCRIPT.includes(String.fromCharCode(92))).toBe(false);
    const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
    expect(layout).toContain('SALA_INIT_SCRIPT');
  });

  it('las fichas de contraste alto existen en @nightpay/ui (oscuro y claro) y suben la letra un paso', () => {
    const css = readFileSync(new URL('../../../../packages/ui/src/styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/html\[data-contrast='sala'\] \{/);
    expect(css).toMatch(/html\[data-theme='light'\]\[data-contrast='sala'\] \{/);
    expect(css).toMatch(/html\.np-staff\[data-contrast='sala'\] \{\s*font-size: 106\.25%;/);
  });
});
