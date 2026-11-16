import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tipLine } from './cobro-view';
import { ACTIVATION_FOR_CLIENT, PIN_CHOOSE, PIN_CHOOSE_HINT, PIN_ENTER, PIN_REPEAT, WAIT_TITLE_EN } from './pin-pad';

// Auditoría de psicología del cliente (prioridad 3) y prioridad 4: lo que el
// cliente lee en el móvil del personal (con su línea en inglés), la verdad
// sobre el PIN, la propina que marcó el personal y unos arreglos de acceso.

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sp = (text: string) => text.split(String.fromCharCode(160)).join(' ');

describe('el PIN (PS-A2 / S-3, PS-A10)', () => {
  it('no promete lo que no es: sí se guarda, pero nadie del local lo ve', () => {
    expect(PIN_CHOOSE_HINT.es).toBe('Tápalo con la mano y no lo digas en voz alta. Nadie del local puede verlo después.');
    expect(PIN_CHOOSE_HINT.en).toBe('Cover it with your hand. Nobody here can see it afterwards.');
    expect(read('../components/PinPad.tsx')).not.toContain('No se guarda en ningún sitio');
  });

  it('cada paso, con su línea en inglés detrás', () => {
    expect(PIN_ENTER).toEqual({ es: 'Pon tu PIN', en: 'Enter your PIN' });
    expect(PIN_CHOOSE).toEqual({ es: 'Elige un PIN de 4 cifras', en: 'Choose a 4-digit PIN' });
    expect(PIN_REPEAT).toEqual({ es: 'Repite el PIN', en: 'Enter it again' });
    const pad = read('../components/PinPad.tsx');
    expect(pad).toMatch(/\{step\.es\}\{' '\}\s*<span lang="en" style=\{enStyle\}>\s*· \{step\.en\}/);
    expect(read('../components/cobrar/PinScreen.tsx')).toMatch(/\{PIN_ENTER\.es\} <span lang="en" className=\{styles\.en\}>· \{PIN_ENTER\.en\}<\/span>/);
  });
});

describe('el cobro abierto, para el cliente (PS-A10, PS-A1)', () => {
  it('el título con su línea en inglés', () => {
    const wait = read('../components/cobrar/Esperando.tsx');
    expect(wait).toMatch(/<p lang="en" className=\{styles\.waitEn\}>\s*\{nfcOn \? waitTitleEnNfc\(readerSpot\) : WAIT_TITLE_EN\.qr\}/);
    expect(WAIT_TITLE_EN.qr).toBe('Scan the QR with your phone');
  });

  it('la propina, a la vista antes de pagar: «33 € + 5 € de propina» (la de un cobro de antes y, con el PIN, la que elige el cliente: B1)', () => {
    const line = tipLine({ baseCents: 3300, tipCents: 500, totalCents: 3800 })!;
    expect(sp(`${line.base} + ${line.tip} de propina`)).toBe('33 € + 5 € de propina');
    expect(tipLine({ baseCents: 3300, tipCents: 0, totalCents: 3300 })).toBeNull();
    const wait = read('../components/cobrar/Esperando.tsx');
    expect(wait).toContain('function staffTipOf(cobro: CobroAbierto)');
    expect(wait).toMatch(/\{staffTip\.base\} \+ \{staffTip\.tip\} de propina/);
    expect(wait).toContain('tipSetup={pinTip}');
    expect(read('../components/cobrar/PinScreen.tsx')).toMatch(/\{tip\.base\} \+ \{tip\.tip\} de propina/);
  });
});

describe('CARGADO: el QR de activación también le habla al cliente (PS-A12)', () => {
  it('«Para ti: escanéalo…» y su línea en inglés', () => {
    expect(ACTIVATION_FOR_CLIENT).toEqual({
      es: 'Para ti: escanéalo y verás tu saldo en tu móvil',
      en: 'Scan to see your balance on your phone',
    });
    expect(read('../components/reception/desk/ActivationQr.tsx')).toMatch(
      /\{ACTIVATION_FOR_CLIENT\.es\} · <span lang="en">\{ACTIVATION_FOR_CLIENT\.en\}<\/span>/,
    );
  });
});

describe('los textos para el cliente', () => {
  const all = [PIN_ENTER, PIN_CHOOSE, PIN_REPEAT, PIN_CHOOSE_HINT, ACTIVATION_FOR_CLIENT].flatMap((t) => [t.es, t.en]).concat(Object.values(WAIT_TITLE_EN));
  it('sin exclamaciones, emojis ni «chica»', () => {
    for (const t of all) {
      expect(t).not.toMatch(/[!¡]/);
      expect(t).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(t).not.toMatch(/chica/i);
    }
  });
});

describe('prioridad 4 del personal', () => {
  it('S-7: el logo que abre el menú, de 44 px y con su «≡»', () => {
    for (const [file, cls] of [['../components/cobrar/cobrar.module.css', 'logoTile'], ['../components/reception/desk/desk.module.css', 'logoBtn']] as const) {
      const css = read(file);
      const block = css.slice(css.indexOf(`.${cls} {`), css.indexOf('}', css.indexOf(`.${cls} {`)));
      expect(block).toContain('min-width: 2.75rem');
      expect(block).toContain('min-height: 2.75rem');
      expect(css).toContain(`.${cls}::after {\n  content: '≡';`);
    }
  });

  it('S-9: el lector dice la palabra de la pantalla («No pagado»)', () => {
    const outcome = read('../../../../packages/ui/src/components/PaymentOutcome.tsx');
    expect(outcome).not.toContain("'Rechazado'");
    expect(outcome).toMatch(/const spoken = \[title, amount/);
  });

  it('S-10: la carta se configura en «Ajustes → Carta»', () => {
    const carta = read('../components/cobrar/Carta.tsx');
    expect(carta).toContain('Ajustes → Carta');
    expect(carta).not.toContain('Administración');
  });

  it('S-12: «Cancelar» dice qué cobro cancela', () => {
    expect(read('../components/MyCobros.tsx')).toContain("aria-label={`Cancelar el cobro ${r.ref ? `${r.ref} ` : ''}de ${formatEur(r.amountCents, { compact: true })}`}");
  });

  it('S-14: el chip de la cabecera, a 14 px en el personal', () => {
    expect(read('../../../../packages/ui/src/styles.css')).toMatch(/\.np-staff\.np-touch \.np-chip \{\s*font-size: var\(--np-fs-14\);/);
  });

  it('S-15: el aviso, en una caja de dentro; <main> sigue siendo la región principal', () => {
    const screen = read('../../../../packages/ui/src/components/ErrorScreen.tsx');
    expect(screen).toContain('<main style={wrap}>');
    expect(screen).toContain('<div role="alert" style={alertBox}>');
  });

  it('S-16: el acceso dice a quién pedir ayuda', () => {
    expect(read('../app/page.tsx')).toContain('¿No puedes entrar? Pide al encargado una contraseña nueva.');
  });
});
