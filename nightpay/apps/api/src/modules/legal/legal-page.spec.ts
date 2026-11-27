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
      expect(html).toContain('Actualizado el 17 de noviembre de 2026');
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

  it('condiciones: el saldo se queda para las próximas visitas y no se devuelve en dinero; un cobro con error, sí', () => {
    const es = renderLegalPage('condiciones', 'es');
    expect(es).not.toContain('que te devolvamos el saldo');
    expect(es).not.toContain('a la tarjeta con la que lo cargaste');
    expect(es).toContain('Lo que no gastes se queda en tu saldo para tus próximas visitas');
    expect(es).toContain('El saldo no se devuelve en dinero, ni en efectivo ni a la tarjeta');
    expect(es).toContain('con bitcoin o al pagar una reserva');
    expect(es).toContain('Si un cobro tiene un error');
    expect(es).toContain('te devolvemos ese cobro');
    expect(es).toContain('solo para cargar saldo y para pagar un reservado, no en la barra');
    const en = renderLegalPage('condiciones', 'en');
    expect(en).not.toContain('unspent balance back');
    expect(en).not.toContain('to the card you loaded it with');
    expect(en).toContain('What you do not spend stays in your balance for your next visits');
    expect(en).toContain('Your balance is not refunded in money, neither in cash nor to your card');
    expect(en).toContain('If a charge has an error');
    expect(en).toContain('we refund that charge');
    expect(en).toContain('only to load your balance and to pay for a reservation, not at the bar');
  });

  it('condiciones: los reservados (señal, cambio de fecha, anular, no venir y si anula el local)', () => {
    const es = renderLegalPage('condiciones', 'es');
    expect(es).toContain('<h2 id="reservados">Reservados</h2>');
    for (const text of [
      'una señal del 30 % del precio',
      'La señal no se devuelve.',
      'cambiar la fecha una sola vez',
      'al menos 48 horas antes de la hora de apertura del local',
      'pierdes la señal y lo demás que hayas pagado se queda como saldo para otra noche',
      'Si no vienes esa noche',
      'Si el local anula la reserva, lo que hayas pagado se queda como saldo para otra noche.',
    ]) {
      expect(es).toContain(text);
    }
    const en = renderLegalPage('condiciones', 'en');
    expect(en).toContain('<h2 id="reservados">Reservations</h2>');
    for (const text of [
      'a deposit of 30 % of the price',
      'The deposit is not refunded.',
      'change the date once',
      'at least 48 hours before the venue’s opening time',
      'you lose the deposit and anything else you paid stays as balance for another night',
      'If you do not show up',
      'If the venue cancels the reservation, what you paid stays as balance for another night.',
    ]) {
      expect(en).toContain(text);
    }
  });

  it('privacidad: los datos de la reserva y el aviso de cada cobro (opcional, con consentimiento)', () => {
    const es = renderLegalPage('privacidad', 'es');
    for (const text of [
      'Si reservas: tu nombre, tu teléfono y las notas que escribas al reservar.',
      'Gestionar tu reserva y hablar contigo sobre ella: hace falta para la reserva que haces (contrato).',
      'Si activas «Avisarme de cada cobro» en tu saldo (es opcional)',
      'Avisarte de cada cobro de tu saldo: tu consentimiento',
      'Los datos de tu reserva (nombre, teléfono y notas)',
      'La suscripción de «Avisarme de cada cobro»: hasta que la quites',
    ]) {
      expect(es).toContain(text);
    }
    expect(es).not.toContain('gestionar tu saldo y sus devoluciones');
    const en = renderLegalPage('privacidad', 'en');
    for (const text of [
      'If you make a reservation: your name, your phone number and the notes you write when booking.',
      'To manage your reservation and contact you about it: needed for the reservation you make (contract).',
      'If you turn on “Notify me of every charge” in your balance (it is optional)',
      'To notify you of every charge on your balance: your consent',
      'Your reservation details (name, phone number and notes)',
      'Your “Notify me of every charge” subscription: until you turn it off',
    ]) {
      expect(en).toContain(text);
    }
    expect(en).not.toContain('manage your balance and its refunds');
  });

  it('privacidad: el justificante por correo (idea 68), solo para enviarlo y sin guardar la dirección', () => {
    expect(renderLegalPage('privacidad', 'es')).toContain(
      'Si pides el justificante por correo: tu dirección, solo para enviártelo (lo envía Resend). No la guardamos en OxioPay.',
    );
    expect(renderLegalPage('privacidad', 'en')).toContain(
      'If you ask for the receipt by email: your email address, only to send it to you (Resend sends it). We do not store it in OxioPay.',
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
