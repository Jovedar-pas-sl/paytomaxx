import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fichaPlace, nfcWayLabel, readReaderSpot, READER_SPOT_KEY, waitTitleEnNfc, writeReaderSpot } from './lector-nfc';
import { METHOD_LABEL } from './cobro-view';
import { pendingLabel, staffVia } from './my-cobros';
import { testReadResult } from './prueba-lectura';

// Lo que pidió el dueño tras ver la app en su datáfono (pantalla de 360×720,
// botones de Android abajo y el lector NFC arriba).

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe('¿Dónde está el lector NFC? (Menú → Este aparato)', () => {
  it('de partida, detrás; «arriba» si se eligió en este aparato', () => {
    expect(readReaderSpot(memoryStore())).toBe('detras');
    expect(readReaderSpot(null)).toBe('detras');
    expect(readReaderSpot(memoryStore({ [READER_SPOT_KEY]: 'arriba' }))).toBe('arriba');
    expect(readReaderSpot(memoryStore({ [READER_SPOT_KEY]: 'cualquier cosa' }))).toBe('detras');
    const broken = { getItem: () => { throw new Error('bloqueado'); } };
    expect(readReaderSpot(broken)).toBe('detras');
  });

  it('se guarda en el aparato (localStorage), sin fallar si no hay dónde', () => {
    const store = memoryStore();
    writeReaderSpot('arriba', store);
    expect(store.data.get(READER_SPOT_KEY)).toBe('arriba');
    expect(() => writeReaderSpot('detras', { setItem: () => { throw new Error('lleno'); } })).not.toThrow();
  });

  it('cambia dónde se pide acercar la ficha: «Por detrás» o «Arriba ↑», y la línea en inglés', () => {
    expect(nfcWayLabel('detras')).toBe('Por detrás');
    expect(nfcWayLabel('arriba')).toBe('Arriba ↑');
    expect(waitTitleEnNfc('detras')).toBe('Hold your tag to the phone or scan the QR');
    expect(waitTitleEnNfc('arriba')).toBe('Hold your tag to the top of the device or scan the QR');
    expect(fichaPlace('detras', 'móvil')).toBe('a la parte de atrás del móvil');
    expect(fichaPlace('detras', 'datáfono')).toBe('a la parte de atrás del datáfono');
    expect(fichaPlace('arriba', 'datáfono')).toBe('a la parte de arriba del aparato');
  });

  it('los textos que decían «parte de atrás» siguen el ajuste', () => {
    const files = ['../components/NewWalletCard.tsx', '../components/pax/PaxSaldoFlow.tsx', '../components/DeviceSheet.tsx'];
    for (const f of files) {
      const src = read(f);
      expect(src).toContain('fichaPlace(');
      expect(src).not.toContain('parte de atrás');
    }
    expect(read('../components/cobrar/Esperando.tsx')).toContain('nfcWayLabel(readerSpot)');
  });
});

describe('prueba de lectura (sin cobrar nada)', () => {
  it('«Leída» (el ✓ es el icono, delante) con lo que lleva y su número de serie', () => {
    expect(testReadResult({ token: 'T', blank: false, uid: '04A23B1C' }).text).toBe('Leída · ficha de OxioPay · nº de serie 04A23B1C');
    expect(testReadResult({ token: null, blank: true, uid: '04A23B1C' }).text).toBe('Leída · ficha en blanco · nº de serie 04A23B1C');
    expect(testReadResult({ token: null, blank: false, uid: null }).text).toBe('Leída · tiene otra cosa grabada');
  });

  it('lee por la escucha de toda la app (readCard → nfc-hub), sin llamar al API', () => {
    const src = read('../components/DeviceSheet.tsx');
    expect(src).toContain('readCard(ctrl.signal)');
    expect(src).not.toMatch(/from '@\/lib\/api/);
  });
});

/** Las palabras de la casa en lo que ve el personal (sin los comentarios del código). */
function visibleSource(): Array<{ file: string; text: string }> {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        const text = readFileSync(path, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        out.push({ file: path, text });
      }
    }
  };
  walk(root);
  return out;
}

describe('palabras de la casa: «ficha» y «Pagado»', () => {
  const sources = visibleSource();
  const banned = ['Acerca el NFC', 'Acerca su NFC', 'Acercar su NFC', 'NFC original', 'Este NFC', 'NFC nuevo', 'Sin NFC', "'Cobrado'", '«Cobrado»', 'Cobrado del saldo', 'Darle una ficha NFC'];

  it.each(banned)('nadie ve «%s»', (phrase) => {
    const hits = sources.filter((s) => s.text.includes(phrase)).map((s) => s.file);
    expect(hits).toEqual([]);
  });

  it('cómo pagó: «Ficha sin PIN» y «Ficha + PIN» (el API dice «NFC sin PIN»)', () => {
    expect(METHOD_LABEL.nfc_nopin).toBe('Ficha sin PIN');
    expect(METHOD_LABEL.pin).toBe('Ficha + PIN');
    expect(staffVia('NFC sin PIN')).toBe('Ficha sin PIN');
    expect(staffVia('NFC')).toBe('Ficha');
    expect(staffVia('Face ID')).toBe('Face ID');
    expect(staffVia(null)).toBeNull();
  });

  it('Mis cobros: «pendientes de pago» (los cobros aún sin pagar, no los pagados)', () => {
    expect(pendingLabel(1)).toBe('1 pendiente de pago');
    expect(pendingLabel(4)).toBe('4 pendientes de pago');
  });
});

describe('en una pantalla de 360×720', () => {
  it('la barra de abajo no tapa lo último: cada página deja su hueco medido', () => {
    expect(read('../components/Dashboard.tsx')).toContain('padding: `var(--np-gap) 1rem ${PAGE_BOTTOM_SPACE}`');
    expect(read('../components/layout.ts')).toContain("export const PAGE_BOTTOM_SPACE = `calc(${TAB_BAR_SPACE} + 1.5rem)`");
    expect(read('../components/TabBar.tsx')).toContain("setProperty('--np-tabbar-space'");
  });

  it('Recepción: las acciones en 2 columnas, sin celdas vacías y de 48 px como poco', () => {
    const css = read('../components/reception/desk/desk.module.css');
    expect(css).toMatch(/\.more \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    expect(css).toMatch(/\.moreBtn:last-child:nth-child\(odd\) \{\s*grid-column: 1 \/ -1;/);
    expect(css).toMatch(/\.moreBtn \{[^}]*min-height: 3rem;/);
  });

  it('la carta vacía: solo una línea fina con «Toca lo que te pide el cliente», sin el botón gris', () => {
    const src = read('../components/cobrar/Carta.tsx');
    expect(src).toMatch(/cuenta\.length === 0 && !busy \? \(\s*<p className=\{styles\.footHint\} data-tour="cobrar-cobrar">/);
  });

  it('el menú del logo: «Este aparato» y «Salir» el último, aparte y en rojo sin llenar', () => {
    for (const f of ['../components/staff-menu.tsx', '../components/cobrar/CobrarFlow.tsx']) {
      const src = read(f);
      expect(src).toContain('{device.item}');
      expect(src.indexOf('<LogoutMenuItem')).toBeGreaterThan(src.indexOf('<GuiaMenuLink />'));
    }
    const menu = read('../components/staff-menu.tsx');
    expect(menu).toContain("color: 'var(--np-danger-text)'");
    expect(menu).not.toMatch(/variant="danger"/);
  });
});
