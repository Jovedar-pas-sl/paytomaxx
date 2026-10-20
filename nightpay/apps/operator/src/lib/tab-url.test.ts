import { afterEach, describe, expect, it, vi } from 'vitest';
import { roleAccess, type TabKey } from './roles';
import { HOME_TAB, parseTab, resolveTab, tabSearch, withoutTab } from './tab-url';
import { clearTabFromUrl, writeTabToUrl } from './use-url-tab';
import { visibleTabsFor } from './venue-methods';
import { DEFAULT_PAYMENT_METHODS } from '@nightpay/contracts';

const ALL: readonly TabKey[] = ['home', 'wallet', 'reception', 'pos', 'payments', 'earnings'];

describe('la pestaña en la URL: leerla', () => {
  it.each([
    ['?t=inicio', 'home'],
    ['?t=saldo', 'wallet'],
    ['?t=recepcion', 'reception'],
    ['?t=pos', 'pos'],
    ['?t=cobros', 'payments'],
    ['?t=ganancias', 'earnings'],
  ] as const)('%s → %s', (search, tab) => {
    expect(parseTab(search)).toBe(tab);
  });

  it('sin ?t= no pide ninguna', () => {
    expect(parseTab('')).toBeNull();
    expect(parseTab('?ficha=abc')).toBeNull();
  });

  it('un nombre que no existe (o el de dentro del código) no pide ninguna', () => {
    expect(parseTab('?t=wallet')).toBeNull();
    expect(parseTab('?t=admin')).toBeNull();
    expect(parseTab('?t=')).toBeNull();
    expect(parseTab('?t=__proto__')).toBeNull();
  });

  it('mayúsculas y espacios de más, igual', () => {
    expect(parseTab('?t=%20Saldo%20')).toBe('wallet');
  });
});

describe('la pestaña en la URL: cuál se enseña', () => {
  it('la pedida, si este rol la tiene', () => {
    expect(resolveTab('earnings', roleAccess('OPERATOR').tabs)).toBe('earnings');
    expect(resolveTab('reception', roleAccess('WAITER').tabs)).toBe('reception');
  });

  it('una de otro rol: Inicio, sin decir nada', () => {
    expect(resolveTab('reception', roleAccess('OPERATOR').tabs)).toBe(HOME_TAB);
    expect(resolveTab('earnings', roleAccess('WAITER').tabs)).toBe(HOME_TAB);
  });

  it('una que el dueño apagó en Formas de cobro: Inicio', () => {
    const noWallet = visibleTabsFor(roleAccess('WAITER').tabs, { ...DEFAULT_PAYMENT_METHODS, wallet: false });
    expect(resolveTab('wallet', noWallet)).toBe(HOME_TAB);
    expect(resolveTab('reception', noWallet)).toBe(HOME_TAB);
    const noPos = visibleTabsFor(roleAccess('WAITER').tabs, { ...DEFAULT_PAYMENT_METHODS, pos: false });
    expect(resolveTab('pos', noPos)).toBe(HOME_TAB);
  });

  it('sin pedir ninguna: Inicio', () => {
    expect(resolveTab(null, ALL)).toBe(HOME_TAB);
  });
});

describe('la pestaña en la URL: escribirla', () => {
  it('pone ?t= con el nombre en castellano', () => {
    expect(tabSearch('', 'wallet')).toBe('?t=saldo');
    expect(tabSearch('?t=saldo', 'earnings')).toBe('?t=ganancias');
  });

  it('Inicio deja la URL limpia', () => {
    expect(tabSearch('?t=saldo', 'home')).toBe('');
    expect(withoutTab('?t=pos')).toBe('');
  });

  it('no toca los otros parámetros (?pos=, ?ficha=)', () => {
    expect(tabSearch('?pos=abc', 'pos')).toBe('?pos=abc&t=pos');
    expect(tabSearch('?ficha=xyz&t=saldo', 'home')).toBe('?ficha=xyz');
  });

  it('ida y vuelta: lo escrito se lee igual', () => {
    for (const tab of ALL) expect(parseTab(tabSearch('', tab)) ?? HOME_TAB).toBe(tab);
  });
});

describe('la pestaña en la URL: el historial', () => {
  function fakeWindow(href: string) {
    const url = new URL(href);
    const history = {
      pushState: vi.fn((_s: unknown, _t: string, next: string) => setUrl(next)),
      replaceState: vi.fn((_s: unknown, _t: string, next: string) => setUrl(next)),
    };
    function setUrl(next: string): void {
      const u = new URL(next, url);
      url.search = u.search;
      url.pathname = u.pathname;
    }
    vi.stubGlobal('window', {
      get location() {
        return { pathname: url.pathname, search: url.search, hash: url.hash };
      },
      history,
    });
    return { history, url };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('cambiar de pestaña añade una entrada («atrás» vuelve)', () => {
    const { history, url } = fakeWindow('https://operator.paytomaxx.com/');
    writeTabToUrl('wallet', 'push');
    expect(history.pushState).toHaveBeenCalledWith(null, '', '/?t=saldo');
    expect(url.search).toBe('?t=saldo');
  });

  it('corregir un valor malo no añade entrada', () => {
    const { history } = fakeWindow('https://operator.paytomaxx.com/?t=recepcion');
    writeTabToUrl('home', 'replace');
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/');
    expect(history.pushState).not.toHaveBeenCalled();
  });

  it('la misma pestaña otra vez no añade nada', () => {
    const { history } = fakeWindow('https://operator.paytomaxx.com/?t=saldo');
    writeTabToUrl('wallet', 'push');
    expect(history.pushState).not.toHaveBeenCalled();
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it('al salir, la URL sin pestaña (y el hash, si lo hay, se queda)', () => {
    const { history } = fakeWindow('https://operator.paytomaxx.com/?t=ganancias#x');
    clearTabFromUrl();
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/#x');
  });
});
