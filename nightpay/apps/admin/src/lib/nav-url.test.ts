import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TAB, navRequestFor, navSearch, parseNav, resolveNav } from './nav-url';
import { PANEL_TABS, visibleSections, type PanelViewer } from './roles';
import { clearNavFromUrl, writeNavToUrl } from './use-url-nav';

const owner: PanelViewer = { role: 'OWNER' };
const manager: PanelViewer = { role: 'MANAGER' };

/** Lo que se enseña con esa URL a ese rol. */
const shown = (search: string, viewer: PanelViewer) => resolveNav(parseNav(search), visibleSections(viewer));

describe('el panel en la URL: leerla', () => {
  it('sección y pestaña', () => {
    expect(parseNav('?s=ajustes&t=formas')).toEqual({ section: 'ajustes', tab: 'methods', hasTab: true });
    expect(parseNav('?s=hoy&t=avisos')).toEqual({ section: 'hoy', tab: 'incidents', hasTab: true });
  });

  it('solo la sección', () => {
    expect(parseNav('?s=chicas')).toEqual({ section: 'chicas', tab: null, hasTab: false });
  });

  it('nombres que no existen no piden nada', () => {
    expect(parseNav('?s=caja&t=methods')).toEqual({ section: null, tab: null, hasTab: true });
    expect(parseNav('?s=__proto__&t=constructor')).toEqual({ section: null, tab: null, hasTab: true });
    expect(parseNav('')).toEqual({ section: null, tab: null, hasTab: false });
  });

  it('mayúsculas y espacios de más, igual', () => {
    expect(parseNav('?s=Ajustes&t=%20PERMISOS')).toEqual({ section: 'ajustes', tab: 'permissions', hasTab: true });
  });
});

describe('el panel en la URL: qué se enseña', () => {
  it('la pestaña pedida, si se ve', () => {
    expect(shown('?s=ajustes&t=formas', owner)).toBe('methods');
    expect(shown('?s=ajustes&t=superadmin', { role: 'OWNER', isSuperAdmin: true })).toBe('superadmin');
    expect(shown('?s=informes&t=informes', { ...manager, canSeeReports: true })).toBe('reports');
  });

  it('la pestaña manda sobre una sección que no le va', () => {
    expect(shown('?s=hoy&t=formas', owner)).toBe('methods');
  });

  it('solo la sección: su primera pestaña', () => {
    expect(shown('?s=ajustes', owner)).toBe('carta');
    expect(shown('?s=chicas', manager)).toBe('operators');
  });

  it('lo del dueño, al encargado: a Hoy sin decir nada', () => {
    expect(shown('?s=ajustes&t=formas', manager)).toBe(DEFAULT_TAB);
    expect(shown('?s=informes&t=banco', manager)).toBe(DEFAULT_TAB);
    expect(shown('?s=informes&t=informes', manager)).toBe(DEFAULT_TAB);
  });

  it('super admin sin serlo, o Datáfonos con el datáfono apagado: a Hoy', () => {
    expect(shown('?s=ajustes&t=superadmin', owner)).toBe(DEFAULT_TAB);
    expect(shown('?s=ajustes&t=datafonos', { ...owner, posOn: false })).toBe(DEFAULT_TAB);
    expect(shown('?s=ajustes&t=datafonos', { ...owner, posOn: true })).toBe('terminals');
  });

  it('una pestaña que no existe no abre su sección: a Hoy', () => {
    expect(shown('?s=ajustes&t=caja', owner)).toBe(DEFAULT_TAB);
  });

  it('sin nada: Hoy · Cobros', () => {
    expect(shown('', owner)).toBe('payments');
  });
});

describe('el panel en la URL: escribirla', () => {
  it('sección y pestaña en castellano', () => {
    expect(navSearch('', 'methods')).toBe('?s=ajustes&t=formas');
    expect(navSearch('', 'night')).toBe('?s=ajustes&t=noche');
    expect(navSearch('?s=ajustes&t=formas', 'operators')).toBe('?s=chicas&t=chicas');
  });

  it('Hoy · Cobros deja la URL limpia; los otros parámetros se quedan', () => {
    expect(navSearch('?s=ajustes&t=formas', 'payments')).toBe('');
    expect(navSearch('?x=1&s=hoy&t=avisos', 'payments')).toBe('?x=1');
  });

  it('ida y vuelta: cada pestaña se lee igual que se escribe', () => {
    const all = visibleSections({ role: 'OWNER', isSuperAdmin: true, canSeeReports: true, posOn: true });
    for (const tab of PANEL_TABS) {
      expect(resolveNav(parseNav(navSearch('', tab.key)), all)).toBe(tab.key);
    }
  });

  it('lo que pide quien navega', () => {
    expect(navRequestFor('permissions')).toEqual({ section: 'ajustes', tab: 'permissions', hasTab: true });
  });
});

describe('el panel en la URL: el historial', () => {
  function fakeWindow(href: string) {
    const url = new URL(href);
    const history = {
      pushState: vi.fn((_s: unknown, _t: string, next: string) => {
        url.search = new URL(next, url).search;
      }),
      replaceState: vi.fn((_s: unknown, _t: string, next: string) => {
        url.search = new URL(next, url).search;
      }),
    };
    vi.stubGlobal('window', {
      get location() {
        return { pathname: url.pathname, search: url.search, hash: url.hash };
      },
      history,
    });
    return history;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ir a otra pestaña añade una entrada («atrás» vuelve)', () => {
    const history = fakeWindow('https://admin.paytomaxx.com/');
    writeNavToUrl('permissions', 'push');
    expect(history.pushState).toHaveBeenCalledWith(null, '', '/?s=ajustes&t=permisos');
  });

  it('corregir no añade entrada; la misma pestaña no hace nada', () => {
    const history = fakeWindow('https://admin.paytomaxx.com/?s=ajustes&t=formas');
    writeNavToUrl('methods', 'push');
    expect(history.pushState).not.toHaveBeenCalled();
    writeNavToUrl('payments', 'replace');
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('al salir, la URL limpia', () => {
    const history = fakeWindow('https://admin.paytomaxx.com/?s=chicas&t=pagos');
    clearNavFromUrl();
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/');
  });
});
