import { describe, expect, it } from 'vitest';
import { DEFAULT_PRINT_MODE, PRINT_MODE_KEY, readPrintMode, writePrintMode } from './print-mode';

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

describe('cómo imprime este aparato', () => {
  it('de partida, con el diálogo de Android (vale en cualquier aparato)', () => {
    expect(DEFAULT_PRINT_MODE).toBe('dialog');
    expect(readPrintMode(memoryStore())).toBe('dialog');
    expect(readPrintMode(null)).toBe('dialog');
    expect(readPrintMode(memoryStore({ [PRINT_MODE_KEY]: 'otra-cosa' }))).toBe('dialog');
  });

  it('«Directo (RawBT)» se guarda en el aparato y se lee', () => {
    const store = memoryStore();
    writePrintMode('rawbt', store);
    expect(store.data.get(PRINT_MODE_KEY)).toBe('rawbt');
    expect(readPrintMode(store)).toBe('rawbt');
    writePrintMode('dialog', store);
    expect(readPrintMode(store)).toBe('dialog');
  });

  it('sin almacenamiento (navegación privada), no rompe', () => {
    const broken = {
      getItem: () => {
        throw new Error('no');
      },
      setItem: () => {
        throw new Error('no');
      },
    };
    expect(readPrintMode(broken)).toBe('dialog');
    expect(() => writePrintMode('rawbt', broken)).not.toThrow();
  });
});
