import { describe, expect, it } from 'vitest';
import { PAY_LANGUAGES } from '../payments/customer-lang';
import { MY_BALANCE_TEXT, myBalanceBlock, myBalanceButton, myBalanceScript } from './my-balance';

const scripts = (html: string): string[] =>
  html.split('<script>').slice(1).map((part) => part.slice(0, part.indexOf('</script>')));

describe('«Ver mi saldo» en las pantallas que acaban', () => {
  it('en los 4 idiomas, con el botón oculto hasta saber que el móvil tiene llave', () => {
    for (const lang of PAY_LANGUAGES) {
      const html = myBalanceButton(lang);
      expect(html).toContain(`>${MY_BALANCE_TEXT[lang].button}</button>`);
      expect(html).toMatch(/id="npMine" hidden/);
      for (const text of Object.values(MY_BALANCE_TEXT[lang])) expect(text.length).toBeGreaterThan(3);
    }
    expect(myBalanceButton('fr')).toContain('Voir mon solde');
    expect(myBalanceButton('pt')).toContain('Ver o meu saldo');
  });

  it('su JS es válido, va a /w/mine y no lleva barras invertidas fuera del JSON', () => {
    for (const lang of PAY_LANGUAGES) {
      const html = myBalanceBlock(lang, { withPasskeyJs: true });
      for (const js of scripts(html)) expect(() => new Function(js)).not.toThrow();
      const js = scripts(myBalanceScript(lang)).join('');
      const withoutConfig = js.replace(/JSON[.]parse[(]"(?:[^"]|"(?!\)))*"[)]/, 'JSON.parse(X)');
      expect(withoutConfig).not.toContain(String.fromCharCode(92));
      expect(js).toContain("pkPrepare(C.base+'/challenge')");
    }
    expect(myBalanceBlock('es')).toMatch(/^npMineShow[(]true[)];$/m);
    expect(myBalanceScript('es')).not.toMatch(/^npMineShow[(]true[)];$/m);
  });

  it('solo va a la página de un saldo de este mismo sitio (/w/<enlace>)', () => {
    const js = scripts(myBalanceScript('es')).join('');
    expect(js).toContain("d.origin!==window.location.origin");
    expect(js).toContain("p[1]!=='w'");
  });
});
