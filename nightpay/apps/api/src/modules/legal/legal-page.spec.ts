import { describe, expect, it } from 'vitest';
import { renderHomeTopUpGone } from '../home-topup/home-topup-page';
import { customerPage } from '../payments/customer-page';
import { PAY_TEXT } from '../payments/pay-i18n';
import { renderWalletUnlockPage } from '../wallets/wallet-unlock-page';
import { LEGAL_DOC_IDS, isLegalDocId, legalDocs, type LegalBlock } from './legal-docs';
import { legalConsent, legalFooter } from './legal-links';
import { LEGAL_OWNER, type LegalOwner } from './legal-owner';
import { renderLegalPage } from './legal-page';

const kind = (b: LegalBlock): string => ('h' in b ? `h${b.id ?? ''}` : 'p' in b ? 'p' : 'ul' in b ? `ul${b.ul.length}` : `table${b.table.rows.length}`);

describe('textos legales', () => {
  it('cada página sale en castellano con los datos del titular y sin marcas sin convertir', () => {
    for (const doc of LEGAL_DOC_IDS) {
      const html = renderLegalPage(doc, 'es');
      expect(html).toContain('<html lang="es">');
      expect(html).toContain(`href="/legal/${doc}?lang=es" aria-current="page"`);
      expect(html).toContain('Actualizado el 16 de noviembre de 2026');
      const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
      expect(main).not.toMatch(/\]\(/);
    }
    const aviso = renderLegalPage('aviso-legal', 'es');
    expect(aviso).toContain('JOVEDAR PAS S.L.');
    expect(aviso).toContain('B56932551');
    expect(aviso).toContain('href="mailto:info@oxiocard.com"');
    expect(aviso).toContain('Datos registrales: Registro Mercantil de Valencia, tomo 11511, folio 171, hoja V-216074');
    expect(aviso).toContain('46005 Valencia');
  });

  it('inglés para en, fr y pt, con el aviso en el idioma elegido', () => {
    expect(renderLegalPage('privacidad', 'en')).toContain('the Spanish version prevails');
    const fr = renderLegalPage('privacidad', 'fr');
    expect(fr).toContain('<html lang="en">');
    expect(fr).toContain('<p class="note" lang="fr">');
    expect(fr).toContain('La version espagnole fait foi');
    expect(fr).toContain('>Confidentialité</a>');
    expect(fr).toContain('Privacy policy');
    expect(renderLegalPage('cookies', 'pt')).toContain('Prevalece a versão espanhola');
    expect(renderLegalPage('cookies', 'es')).not.toContain('class="note"');
  });

  it('los enlaces internos llevan el idioma y los externos se abren aparte', () => {
    const html = renderLegalPage('aviso-legal', 'fr');
    expect(html).toContain('href="/legal/privacidad?lang=fr"');
    expect(renderLegalPage('privacidad', 'es')).toContain(
      '<a href="https://www.aepd.es" target="_blank" rel="noopener noreferrer">www.aepd.es</a>',
    );
  });

  it('escapa los datos del titular y solo pone los registrales si los hay', () => {
    const owner: LegalOwner = { ...LEGAL_OWNER, name: '<b>X</b>', registry: null };
    const html = renderLegalPage('aviso-legal', 'es', owner);
    expect(html).toContain('&lt;b&gt;X&lt;/b&gt;');
    expect(html).not.toContain('<b>X</b>');
    expect(html).not.toContain('Datos registrales');
    expect(renderLegalPage('aviso-legal', 'es', { ...owner, registry: 'RM Valencia, tomo 1' })).toContain(
      'Datos registrales: RM Valencia, tomo 1',
    );
  });

  it('el castellano y el inglés tienen los mismos bloques, en el mismo orden', () => {
    const es = legalDocs('es', LEGAL_OWNER);
    const en = legalDocs('en', LEGAL_OWNER);
    for (const doc of LEGAL_DOC_IDS) expect(en[doc].blocks.map(kind)).toEqual(es[doc].blocks.map(kind));
  });

  it('solo acepta las cuatro páginas', () => {
    expect(LEGAL_DOC_IDS.every(isLegalDocId)).toBe(true);
    expect(isLegalDocId('../etc')).toBe(false);
    expect(isLegalDocId(undefined)).toBe(false);
  });
});

describe('enlaces legales en las páginas del cliente', () => {
  it('el pie enlaza las cuatro páginas en el idioma de la página', () => {
    const html = legalFooter('pt');
    for (const doc of LEGAL_DOC_IDS) expect(html).toContain(`href="/legal/${doc}?lang=pt"`);
    expect(html).toContain('aria-label="Informações legais"');
  });

  it('«Al pagar aceptas…» enlaza las condiciones y la privacidad', () => {
    expect(legalConsent('es')).toBe(
      '<p class="legal-ok">Al pagar aceptas las <a href="/legal/condiciones?lang=es">Condiciones</a> y la <a href="/legal/privacidad?lang=es">Política de privacidad</a>.</p>',
    );
  });

  it('lo llevan las páginas de pago, del saldo y de la carga desde casa', () => {
    expect(customerPage(PAY_TEXT.en, 'Paid', '<p>ok</p>')).toContain('href="/legal/aviso-legal?lang=en"');
    expect(renderWalletUnlockPage('/w/test-token', 'es')).toContain('class="legal-foot"');
    expect(renderHomeTopUpGone('fr')).toContain('href="/legal/cookies?lang=fr"');
  });
});
