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

  it('idea 71: la franja «English? · Switch» encima de la barra, con ✕ para seguir en español; nunca sobre el «Pagado»', () => {
    const html = topBar('es', undefined, { suggest: 'en' });
    expect(html).toBe(
      `<nav class="sug" aria-label="Idioma"><a href="?lang=en" lang="en" hreflang="en">English? · Switch</a><a class="x" href="?lang=es" aria-label="Seguir en español">✕</a></nav>${topBar('es')}`,
    );
    const NNBSP = String.fromCharCode(0x202f);
    expect(topBar('es', undefined, { suggest: 'fr' })).toContain(`lang="fr" hreflang="fr">Français${NNBSP}? · Changer</a>`);
    expect(topBar('es', undefined, { suggest: 'pt' })).toContain('lang="pt" hreflang="pt">Português? · Mudar</a>');
    // Los dos enlaces son la misma página con sus parámetros (la propina elegida en la pantalla, ?tip=).
    const keepTip = topBar('es', langHrefWith('/pay/tok', { tip: '500' }), { suggest: 'en' });
    expect(keepTip).toContain('<a href="/pay/tok?tip=500&amp;lang=en" lang="en" hreflang="en">');
    expect(keepTip).toContain('<a class="x" href="/pay/tok?tip=500&amp;lang=es" aria-label="Seguir en español">');
    // Sin sugerencia, o encima del «Pagado» (over), no hay franja.
    expect(topBar('es', undefined, { suggest: null })).toBe(topBar('es'));
    expect(topBar('es', undefined, { over: true, suggest: 'en' })).toBe(topBar('es', undefined, { over: true }));
    // 44 px de alto, superficie 2 y letra de 14 px; la ✕, un toque de 44 × 44.
    expect(CHROME_CSS).toContain('.sug{display:flex;justify-content:center;background:var(--surface-2);font-size:.875rem}');
    expect(CHROME_CSS).toMatch(/\.sug a\{[^}]*min-height:2\.75rem/);
    expect(CHROME_CSS).toMatch(/\.sug \.x\{[^}]*width:2\.75rem/);
    // Sin JS: son enlaces; el API guarda la elección en la cookie al llegar con ?lang=.
    expect(html).not.toContain('<script');
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

  function languagePage({ saved = null, cookie = '', lang = 'es', search = '', now = 1_700_000_000_000 }: {
    saved?: string | null; cookie?: string; lang?: string; search?: string; now?: number;
  } = {}) {
    let value = saved;
    let cookieValue = cookie;
    const writes: string[] = [];
    const handlers: Record<string, () => void> = {};
    const storage = {
      getItem: vi.fn(() => value),
      setItem: vi.fn((_key: string, next: string) => { value = next; }),
      removeItem: vi.fn(() => { value = null; }),
    };
    const links = ['es', 'en', 'fr', 'pt'].map((language) => ({
      getAttribute: () => language,
      addEventListener: (_event: string, handler: () => void) => { handlers[language] = handler; },
    }));
    const doc = {
      get cookie() { return cookieValue; },
      set cookie(next: string) { writes.push(next); cookieValue = next.split(';')[0]; },
      documentElement: { lang },
      getElementById: () => ({ querySelectorAll: () => links }),
      addEventListener: () => undefined,
    };
    const location = { search, pathname: '/pay/result', protocol: 'https:', replace: vi.fn() };
    const run = new Function('document', 'localStorage', 'location', 'URLSearchParams', 'Date', LANG_JS);
    run(doc, storage, location, URLSearchParams, { now: () => now });
    return { storage, location, handlers, writes, current: () => value };
  }

  it('recupera el idioma vigente sin cookie y conserva los demás parámetros', () => {
    const now = 1_700_000_000_000;
    const page = languagePage({ saved: `fr.${now + 60_000}`, search: '?op=1', now });
    expect(page.location.replace).toHaveBeenCalledWith('/pay/result?op=1&lang=fr');
    expect(page.storage.setItem).not.toHaveBeenCalled();
  });

  it('descarta un idioma caducado o del formato antiguo sin recuperarlo', () => {
    const now = 1_700_000_000_000;
    for (const saved of [`fr.${now}`, `fr.${now - 1}`, 'fr', 'fr.no-fecha', '']) {
      const page = languagePage({ saved, now });
      expect(page.location.replace).not.toHaveBeenCalled();
      expect(page.storage.removeItem).toHaveBeenCalledWith('np_lang');
      expect(page.current()).toBeNull();
    }
  });

  it('al elegir un idioma guarda la cookie y el plazo de doce horas', () => {
    const now = 1_700_000_000_000;
    const page = languagePage({ now });
    page.handlers.en();
    expect(page.writes).toContain('np_lang=en; Path=/; Max-Age=43200; SameSite=Lax; Secure');
    expect(page.current()).toBe(`en.${now + 43_200_000}`);
  });

  it('una elección nueva por URL fija el plazo, pero las visitas no lo alargan', () => {
    const now = 1_700_000_000_000;
    const chosen = languagePage({ saved: `en.${now + 5000}`, cookie: 'np_lang=fr', lang: 'fr', search: '?lang=fr', now });
    expect(chosen.current()).toBe(`fr.${now + 43_200_000}`);
    const until = now + 60_000;
    const visit = languagePage({ saved: `fr.${until}`, cookie: 'np_lang=fr', lang: 'fr', now });
    expect(visit.storage.setItem).not.toHaveBeenCalled();
    expect(visit.current()).toBe(`fr.${until}`);
  });

  it('si se recupera sin cookie, la cookie nueva dura solo lo que faltaba', () => {
    const now = 1_700_000_000_000;
    const saved = `fr.${now + 60_000}`;
    const page = languagePage({ saved, cookie: 'np_lang=fr', lang: 'fr', search: '?op=1&lang=fr', now });
    expect(page.storage.setItem).not.toHaveBeenCalled();
    expect(page.writes).toContain('np_lang=fr; Path=/; Max-Age=60; SameSite=Lax; Secure');
  });

  it('si queda un valor antiguo y su cookie antigua, vuelve a español', () => {
    const page = languagePage({ saved: 'en', cookie: 'np_lang=en', lang: 'en' });
    expect(page.storage.removeItem).toHaveBeenCalledWith('np_lang');
    expect(page.writes.some((value) => value.includes('Max-Age=0'))).toBe(true);
    expect(page.location.replace).toHaveBeenCalledWith('/pay/result');
  });

  it('todas las páginas de aviso lo llevan', () => {
    const html = renderNoticePage('en', PAY_TEXT.en.notFound, 'warn');
    expect(html).toContain('<details class="lang" id="langMenu">');
    expect(html).toContain('aria-current="true">English</a>');
  });
});
