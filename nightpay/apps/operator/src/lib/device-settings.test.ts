import { describe, expect, it } from 'vitest';
import {
  BIGFONT_KEY,
  HAPTIC_KEY,
  THEME_KEY,
  hapticEnabled,
  readBigFont,
  readThemeChoice,
  resolveTheme,
  writeBigFont,
  writeHaptic,
  writeThemeChoice,
  type KeyValueStore,
} from '../../../../packages/ui/src/lib/device-settings';

function memory(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}
const broken: KeyValueStore = {
  getItem: () => {
    throw new Error('bloqueado');
  },
  setItem: () => {
    throw new Error('bloqueado');
  },
  removeItem: () => {
    throw new Error('bloqueado');
  },
};

describe('tema (reusa np-theme)', () => {
  it('lee oscuro, claro o como el móvil; sin ajuste o con basura, el de partida', () => {
    expect(readThemeChoice(memory({ [THEME_KEY]: 'light' }), 'dark')).toBe('light');
    expect(readThemeChoice(memory({ [THEME_KEY]: 'dark' }), 'system')).toBe('dark');
    expect(readThemeChoice(memory({ [THEME_KEY]: 'system' }), 'dark')).toBe('system');
    expect(readThemeChoice(memory(), 'dark')).toBe('dark');
    expect(readThemeChoice(memory(), 'system')).toBe('system');
    expect(readThemeChoice(memory({ [THEME_KEY]: 'azul' }), 'dark')).toBe('dark');
    expect(readThemeChoice(broken, 'dark')).toBe('dark');
  });
  it('como el móvil sigue al sistema; lo demás es lo elegido', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
  it('guarda en np-theme y no falla con el almacenamiento bloqueado', () => {
    const s = memory();
    writeThemeChoice(s, 'system');
    expect(s.data[THEME_KEY]).toBe('system');
    expect(() => writeThemeChoice(broken, 'light')).not.toThrow();
  });
});

describe('vibrar al tocar', () => {
  it('por defecto sí; solo off lo apaga; con el almacenamiento bloqueado, sí', () => {
    expect(hapticEnabled(memory())).toBe(true);
    expect(hapticEnabled(memory({ [HAPTIC_KEY]: 'off' }))).toBe(false);
    expect(hapticEnabled(memory({ [HAPTIC_KEY]: 'raro' }))).toBe(true);
    expect(hapticEnabled(broken)).toBe(true);
  });
  it('apagar guarda off; encender borra el ajuste', () => {
    const s = memory();
    writeHaptic(s, false);
    expect(s.data[HAPTIC_KEY]).toBe('off');
    writeHaptic(s, true);
    expect(HAPTIC_KEY in s.data).toBe(false);
  });
});

describe('letra más grande', () => {
  it('por defecto no; guardar y leer; bloqueado no falla', () => {
    const s = memory();
    expect(readBigFont(s)).toBe(false);
    writeBigFont(s, true);
    expect(s.data[BIGFONT_KEY]).toBe('1');
    expect(readBigFont(s)).toBe(true);
    writeBigFont(s, false);
    expect(readBigFont(s)).toBe(false);
    expect(readBigFont(broken)).toBe(false);
    expect(() => writeBigFont(broken, true)).not.toThrow();
  });
});
