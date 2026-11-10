import { describe, expect, it, vi } from 'vitest';
import { createHelpStore, HELP_KEY_PREFIX, helpKey, isHelpHidden, saveHelpHidden, type HelpStorage } from './help-line';

/** Un localStorage de mentira (y, si hace falta, que falle al leer o al escribir). */
function memory(fail: { read?: boolean; write?: boolean } = {}): HelpStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => {
      if (fail.read) throw new Error('SecurityError');
      return data.get(k) ?? null;
    },
    setItem: (k, v) => {
      if (fail.write) throw new Error('QuotaExceededError');
      data.set(k, v);
    },
    removeItem: (k) => {
      if (fail.write) throw new Error('QuotaExceededError');
      data.delete(k);
    },
  };
}

describe('la clave de cada pantalla', () => {
  it('una por pantalla, con su prefijo', () => {
    expect(HELP_KEY_PREFIX).toBe('np-ayuda-');
    expect(helpKey('cobros')).toBe('np-ayuda-cobros');
    expect(helpKey('recepcion-importe')).not.toBe(helpKey('recepcion-pago'));
  });
});

describe('leer y guardar en este móvil', () => {
  it('de entrada, la ayuda se ve', () => {
    expect(isHelpHidden(memory(), 'cobros')).toBe(false);
  });

  it('«Entendido» la cierra solo en esa pantalla; «?» la vuelve a abrir', () => {
    const s = memory();
    expect(saveHelpHidden(s, 'cobros', true)).toBe(true);
    expect(s.data.get('np-ayuda-cobros')).toBe('1');
    expect(isHelpHidden(s, 'cobros')).toBe(true);
    expect(isHelpHidden(s, 'recepcion-nfc')).toBe(false);
    expect(saveHelpHidden(s, 'cobros', false)).toBe(true);
    expect(s.data.has('np-ayuda-cobros')).toBe(false);
    expect(isHelpHidden(s, 'cobros')).toBe(false);
  });

  it('sin almacenamiento, o si falla, se sigue viendo (nunca lanza)', () => {
    expect(isHelpHidden(null, 'cobros')).toBe(false);
    expect(saveHelpHidden(null, 'cobros', true)).toBe(false);
    expect(isHelpHidden(memory({ read: true }), 'cobros')).toBe(false);
    expect(saveHelpHidden(memory({ write: true }), 'cobros', true)).toBe(false);
  });

  it('un valor raro guardado no la esconde', () => {
    const s = memory();
    s.data.set('np-ayuda-cobros', 'true');
    expect(isHelpHidden(s, 'cobros')).toBe(false);
  });
});

describe('lo que comparten la línea y su «?»', () => {
  it('cerrar y abrir avisa a quien mira, y deja de avisar al soltarse', () => {
    const s = memory();
    const store = createHelpStore(() => s);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    expect(store.hide('cobros')).toBe(true);
    expect(store.isHidden('cobros')).toBe(true);
    store.show('cobros');
    expect(store.isHidden('cobros')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    store.hide('cobros');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('si no se puede guardar, «Entendido» no la esconde: se sigue viendo', () => {
    const store = createHelpStore(() => memory({ write: true }));
    expect(store.hide('cobros')).toBe(false);
    expect(store.isHidden('cobros')).toBe(false);
  });

  it('sin localStorage (el servidor), se ve', () => {
    const store = createHelpStore(() => null);
    expect(store.isHidden('cobros')).toBe(false);
    expect(store.hide('cobros')).toBe(false);
  });
});
