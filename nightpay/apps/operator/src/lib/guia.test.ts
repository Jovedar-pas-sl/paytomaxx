import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NO_PIN_SENTENCE, NO_PIN_TITLE } from './cobro-view';
import { GUIA_CARGAR, GUIA_COBRAR, GUIA_PATH, GUIA_SECTIONS, guiaImages, guiaSituations, outOfCobros } from './guia';
import { myCobrosSituations } from './my-cobros-help';
import { AMOUNT_HELP, METHOD_HELP, loadedHelp, tapHelp } from './reception-help';

// La «Guía rápida» (/guia): los pasos de cobrar y de cargar una ficha, cada
// uno con su captura (WebP ligera en public/guia), y «Qué hago si…» con los
// mismos textos que salen en la app.

const PUBLIC = new URL('../../public', import.meta.url);
const fileOf = (src: string) => new URL(`.${src}`, `${PUBLIC.href}/`);
const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** Ancho y alto de un WebP (cabecera RIFF: VP8, VP8L o VP8X). */
function webpSize(buf: Buffer): { width: number; height: number } {
  expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
  expect(buf.toString('ascii', 8, 12)).toBe('WEBP');
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  expect(chunk).toBe('VP8 ');
  return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
}

describe('la ruta /guia', () => {
  it('es su propia página de la app del personal', () => {
    expect(GUIA_PATH).toBe('/guia');
    const page = source('../app/guia/page.tsx');
    expect(page).toMatch(/export default function GuiaPage\(\)/);
    expect(page).toContain('<Guia />');
    expect(page).toContain("title: 'Guía rápida — OxioPay'");
  });
});

describe('cómo cobrar', () => {
  it('carta → cuenta → «Cobrar» → el cliente paga con QR o ficha → Pagado, en ese orden', () => {
    expect(GUIA_COBRAR.steps.map((s) => s.image)).toEqual([
      '/guia/cobrar-1-carta.webp',
      '/guia/cobrar-2-cuenta.webp',
      '/guia/cobrar-3-qr.webp',
      '/guia/cobrar-4-cliente.webp',
      '/guia/cobrar-5-pagado.webp',
    ]);
    const [carta, cuenta, qr, cliente, pagado] = GUIA_COBRAR.steps.map((s) => s.text);
    expect(carta).toContain('«Deshacer»');
    expect(cuenta).toContain('«Ver cuenta»');
    expect(cuenta).toContain('«Cobrar»');
    expect(qr).toMatch(/QR/);
    expect(qr).toMatch(/ficha/);
    expect(cliente).toMatch(/Apple Pay, Google Pay o tarjeta/);
    expect(pagado).toContain('«Pagado»');
    expect(pagado).toContain('«Nuevo cobro»');
  });

  it('los botones que nombra son los que hay en la app', () => {
    const carta = source('../components/cobrar/Carta.tsx');
    const esperando = source('../components/cobrar/Esperando.tsx');
    expect(carta).toMatch(/>\s*Deshacer\s*</);
    expect(carta).toMatch(/>\s*Ver cuenta\s*</);
    expect(esperando).toContain("label: 'Nuevo cobro'");
  });
});

describe('cómo cargar una ficha', () => {
  it('cada paso dice lo mismo que la línea de ayuda de esa pantalla de recepción', () => {
    expect(GUIA_CARGAR.steps.map((s) => s.text)).toEqual([
      tapHelp('entrada'),
      AMOUNT_HELP,
      METHOD_HELP,
      loadedHelp({ method: 'cash', handOver: 'give', pin: 'ask' }),
    ]);
  });
});

describe('qué hago si…', () => {
  it('los de «Cobros» y el de la ficha sin PIN, con sus mismas palabras', () => {
    const cobros = myCobrosSituations({ cancelPending: false });
    const guia = guiaSituations();
    expect(guia.map((c) => c.when)).toEqual([...cobros.map((c) => c.when), NO_PIN_TITLE]);
    expect(guia.map((c) => c.todo)).toEqual([...cobros.map((c) => outOfCobros(c.todo)), NO_PIN_SENTENCE]);
  });

  it('fuera de «Cobros» no dice «aquí»: dice dónde (si la app añade otro «aquí», esto avisa)', () => {
    for (const c of guiaSituations()) expect(c.todo).not.toMatch(/\baquí\b/i);
    expect(guiaSituations()[2]!.todo).toContain('Busca sus cobros en «Cobros».');
  });

  it('de lo de la app solo cambia el «aquí»', () => {
    expect(outOfCobros('Busca sus cobros aquí. Si pone…')).toBe('Busca sus cobros en «Cobros». Si pone…');
    expect(outOfCobros('Desde aquí no se puede: avisa al encargado.')).toBe('Desde la app no se puede: avisa al encargado.');
    expect(outOfCobros('Que vaya a recepción: allí, en «Salida», se lo devuelven en efectivo.')).toBe(
      'Que vaya a recepción: allí, en «Salida», se lo devuelven en efectivo.',
    );
  });
});

describe('los textos', () => {
  const texts = [
    ...GUIA_SECTIONS.flatMap((s) => [s.title, s.lead ?? '', ...s.steps.flatMap((st) => [st.text, st.alt])]),
    ...guiaSituations().flatMap((c) => [c.when, c.todo]),
  ];

  it('sin «chica», «chicas» ni «habitación»', () => {
    for (const t of texts) expect(t).not.toMatch(/chicas?\b|habitaci/i);
  });

  it('en español llano: sin exclamaciones ni emojis', () => {
    for (const t of texts) {
      expect(t).not.toMatch(/[!¡]/);
      expect(t).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('una frase corta por paso', () => {
    for (const s of GUIA_SECTIONS) for (const st of s.steps) expect(st.text.length).toBeLessThanOrEqual(110);
  });
});

describe('las capturas', () => {
  it('existen en public/guia, son WebP, pesan menos de 80 KB y miden lo que dice la página', () => {
    for (const s of GUIA_SECTIONS) {
      for (const st of s.steps) {
        const file = fileOf(st.image);
        expect(existsSync(file), st.image).toBe(true);
        expect(statSync(file).size, st.image).toBeLessThan(80 * 1024);
        expect(webpSize(readFileSync(file)), st.image).toEqual({ width: st.width, height: st.height });
      }
    }
  });

  it('no sobra ninguna en public/guia', () => {
    const used = new Set(guiaImages().map((src) => src.replace('/guia/', '')));
    expect(readdirSync(new URL('./guia', `${PUBLIC.href}/`)).sort()).toEqual([...used].sort());
  });
});
