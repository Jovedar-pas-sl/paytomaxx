import { describe, expect, it } from 'vitest';
import { paidTicket, testTicket } from './ticket';
import {
  PRINT_WIDTH_DOTS,
  RAWBT_PACKAGE,
  bytesToBase64,
  escPosImage,
  paintTicket,
  rasterBits,
  rawbtIntentUrl,
  wrapBalanced,
  wrapText,
  type TicketPainter,
} from './ticket-raster';

const AT = new Date('2026-11-16T15:20:00Z');

/** Un lienzo de mentira: cada letra mide la mitad del tamaño de la letra; apunta lo que se pinta. */
function fakePainter() {
  const texts: Array<{ text: string; x: number; y: number; align: string; font: string }> = [];
  const rects: Array<[number, number, number, number]> = [];
  const p: TicketPainter = {
    font: '10px x',
    textAlign: 'left',
    textBaseline: 'top',
    fillStyle: '#000',
    fillText(text, x, y) {
      texts.push({ text, x, y, align: p.textAlign, font: p.font });
    },
    fillRect(x, y, w, h) {
      rects.push([x, y, w, h]);
    },
    measureText(text) {
      const size = Number(/(\d+)px/.exec(p.font)?.[1] ?? 10);
      return { width: text.length * size * 0.5 };
    },
  };
  return { p, texts, rects };
}

describe('el ticket dibujado', () => {
  it('parte lo largo en líneas que caben (y una palabra larga, a trozos)', () => {
    const { p } = fakePainter();
    p.font = '20px x';
    expect(wrapText(p, 'uno dos tres cuatro', 75)).toEqual(['uno dos', 'tres', 'cuatro']);
    expect(wrapText(p, 'abcdefghij', 40)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('lo centrado, con las líneas parejas (sin una palabra sola abajo)', () => {
    const { p } = fakePainter();
    p.font = '20px x';
    // A lo ancho: «uno dos tres cuatro cinco» + «seis»; parejo: tres y tres.
    expect(wrapText(p, 'uno dos tres cuatro cinco seis', 260)).toEqual(['uno dos tres cuatro cinco', 'seis']);
    expect(wrapBalanced(p, 'uno dos tres cuatro cinco seis', 260)).toEqual(['uno dos tres', 'cuatro cinco seis']);
    expect(wrapBalanced(p, 'corto', 260)).toEqual(['corto']);
  });

  it('pinta local, número y hora, líneas, total y pago; mide lo mismo que dibuja', () => {
    const t = paidTicket({
      venue: 'Luna Valencia',
      number: 'C-0063',
      lines: [{ label: 'Gin tonic', qty: 2, unitCents: 1200, amountCents: 2400 }],
      totalCents: 2400,
      at: AT,
    });
    const dry = fakePainter();
    const measured = paintTicket(dry.p, t, PRINT_WIDTH_DOTS, false);
    expect(dry.texts).toEqual([]);
    expect(dry.rects).toEqual([]);

    const real = fakePainter();
    const height = paintTicket(real.p, t, PRINT_WIDTH_DOTS, true);
    expect(height).toBe(measured);
    const words = real.texts.map((x) => x.text);
    expect(words).toContain('Luna Valencia');
    expect(words).toContain('Nº C-0063');
    expect(words).toContain('16/11/2026 16:20');
    expect(words).toContain('2× Gin tonic');
    expect(words).toContain('TOTAL');
    expect(words.some((w) => /^24,00\s€$/.test(w))).toBe(true);
    // Los importes, a la derecha y dentro del papel.
    const total = real.texts.find((x) => x.text === 'TOTAL')!;
    const totalValue = real.texts.find((x) => x.y === total.y && x.align === 'right')!;
    expect(totalValue.x).toBeLessThanOrEqual(PRINT_WIDTH_DOTS);
  });

  it('el QR, con módulos enteros y centrado', () => {
    const { p, rects } = fakePainter();
    paintTicket(p, testTicket(AT, 'https://operator.example'), PRINT_WIDTH_DOTS, true);
    const squares = rects.filter(([, , w, h]) => w === h && w > 2);
    expect(squares.length).toBeGreaterThan(50);
    const size = squares[0]![2];
    expect(squares.every(([, , w]) => w === size)).toBe(true);
    const xs = squares.map(([x]) => x);
    const left = Math.min(...xs);
    const right = Math.max(...xs) + size;
    expect(Math.abs(left + right - PRINT_WIDTH_DOTS)).toBeLessThanOrEqual(size * 8 + 2);
  });

  it('píxeles → un bit por punto (negro = 1), lo transparente es papel', () => {
    // 10 × 1: negro, blanco, gris oscuro, gris claro, transparente, negro…
    const px = [
      [0, 0, 0, 255],
      [255, 255, 255, 255],
      [60, 60, 60, 255],
      [200, 200, 200, 255],
      [0, 0, 0, 0],
      [0, 0, 0, 255],
      [255, 255, 255, 255],
      [0, 0, 0, 255],
      [0, 0, 0, 255],
      [255, 255, 255, 255],
    ].flat();
    const bits = rasterBits(px, 10, 1);
    expect(Array.from(bits)).toEqual([0b10100101, 0b10000000]);
  });

  it('ESC/POS: iniciar, la imagen por bloques (GS v 0) y avanzar para cortar', () => {
    const width = 16;
    const height = 200;
    const bits = new Uint8Array(2 * height).fill(0xff);
    const out = escPosImage(bits, width, height, 120);
    expect(Array.from(out.slice(0, 2))).toEqual([0x1b, 0x40]);
    // Primer bloque: 96 filas de 2 bytes.
    expect(Array.from(out.slice(2, 10))).toEqual([0x1d, 0x76, 0x30, 0x00, 2, 0, 96, 0]);
    // ESC J 120: 15 mm de papel para cortar.
    expect(Array.from(out.slice(-3))).toEqual([0x1b, 0x4a, 120]);
    // 200 filas = 96 + 96 + 8: tres cabeceras de 8 bytes.
    expect(out.length).toBe(2 + 3 * 8 + 2 * height + 3);
  });

  it('el enlace de RawBT lleva los bytes en base64 y su paquete', () => {
    const bytes = Uint8Array.from([0x1b, 0x40, 0x0a]);
    expect(bytesToBase64(bytes)).toBe('G0AK');
    expect(rawbtIntentUrl(bytes)).toBe(`intent:base64,G0AK#Intent;scheme=rawbt;package=${RAWBT_PACKAGE};end;`);
    const big = new Uint8Array(70_000).fill(65);
    expect(bytesToBase64(big)).toBe(Buffer.from(big).toString('base64'));
  });
});
