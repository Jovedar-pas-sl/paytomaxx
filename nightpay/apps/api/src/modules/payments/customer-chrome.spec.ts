import { describe, expect, it, vi } from 'vitest';
import { CHROME_CSS, LANG_JS, langHrefWith, langMenu, topBar } from './customer-chrome';
import { renderNoticePage, renderResultView } from './public-pay.pages';
import { PAY_TEXT } from './pay-i18n';

const BACKSLASH = String.fromCharCode(92);

/**
 * El selector de idioma de las páginas del cliente: arriba a la derecha,
 * discreto, cada idioma con su nombre en su idioma, sin banderas; sin JS
 * funciona (enlaces) y con JS recuerda la elección (cookie y localStorage).
 */
describe('selector de idioma', () => {
  it('los cuatro idiomas con su nombre en su idioma; el actual marcado; etiqueta para lectores de pantalla', () => {
    const html = langMenu('pt');
    expect(html).toContain('<summary aria-label="Idioma: Português">');
    expect(html).toContain('<span aria-hidden="true">PT</span>');
    expect(html).toContain('data-lang="es">Español</a>');
    expect(html).toContain('data-lang="en">English</a>');
    expect(html).toContain('data-lang="fr">Français</a>');
    expect(html).toContain('aria-current="true">Português</a>');
    expect(html.match(/aria-current/g)).toHaveLength(1);
    // Sin banderas (ni emojis de bandera ni imágenes).
    expect(html).not.toMatch(/<img|🇪|🇬|🇫|🇵/u);
    expect(langMenu('fr')).toContain('<summary aria-label="Langue: Français">');
  });

  it('cada enlace es la misma página en otro idioma; con sus parámetros si los tiene (y escapados)', () => {
    expect(langMenu('es')).toContain('<a href="?lang=en" lang="en" hreflang="en"');
    const href = langHrefWith('/pay/result', { op: 'A1&b', status: null });
    expect(href('fr')).toBe('/pay/result?op=A1%26b&lang=fr');
    expect(langMenu('es', href)).toContain('href="/pay/result?op=A1%26b&amp;lang=pt"');
  });

  it('la vuelta del banco y sus avisos conservan el pedido al cambiar de idioma', () => {
    const html = renderResultView(null, 'es', '/pay/result?op=ORD1&lang=es');
    expect(html).toContain('href="/pay/result?op=ORD1&amp;lang=en"');
    expect(html).toContain('<html lang="es">');
  });

  it('arriba a la derecha (con el logo a la izquierda), con 48 px de toque y foco visible', () => {
    expect(topBar('es')).toMatch(/^<header class="top"><img class="wm"[^>]*>(<details class="lang")/);
    expect(CHROME_CSS).toContain('.lang summary{list-style:none;display:inline-flex;align-items:center;gap:.4rem;min-height:3rem;min-width:3rem');
    expect(CHROME_CSS).toContain('.lang summary:focus-visible{outline:3px solid var(--fg)');
    expect(CHROME_CSS).toContain('.lang a{display:flex;align-items:center;justify-content:space-between;gap:.75rem;min-height:3rem');
  });

  it('el JS sin barras invertidas, válido y que no rompe la página si el navegador bloquea cookies o localStorage', () => {
    expect(LANG_JS).not.toContain(BACKSLASH);
    expect(CHROME_CSS).not.toContain(BACKSLASH);
    const run = new Function('document', 'localStorage', 'location', 'URLSearchParams', LANG_JS);
    const throwing = {
      get cookie(): string {
        throw new Error('bloqueada');
      },
      documentElement: { lang: 'es' },
      getElementById: () => null,
    };
    expect(() => run(throwing, { getItem: () => { throw new Error('x'); } }, { search: '' }, URLSearchParams)).not.toThrow();
  });

  it('si la cookie se perdió pero el navegador recuerda el idioma, la página se vuelve a pedir en ese idioma', () => {
    const replace = vi.fn();
    const run = new Function('document', 'localStorage', 'location', 'URLSearchParams', LANG_JS);
    const doc = { cookie: '', documentElement: { lang: 'es' }, getElementById: () => null, addEventListener: () => undefined };
    run(doc, { getItem: () => 'fr', setItem: () => undefined }, { search: '?op=1', pathname: '/pay/result', replace, protocol: 'https:' }, URLSearchParams);
    expect(replace).toHaveBeenCalledWith('/pay/result?op=1&lang=fr');
    // Con la cookie (o con ?lang en la URL), manda lo que dice la página.
    const again = vi.fn();
    run({ ...doc, cookie: 'np_lang=es' }, { getItem: () => 'fr', setItem: () => undefined }, { search: '', pathname: '/w/x', replace: again }, URLSearchParams);
    expect(again).not.toHaveBeenCalled();
  });

  it('todas las páginas de aviso lo llevan', () => {
    const html = renderNoticePage('en', PAY_TEXT.en.notFound, 'warn');
    expect(html).toContain('<details class="lang" id="langMenu">');
    expect(html).toContain('aria-current="true">English</a>');
  });
});
