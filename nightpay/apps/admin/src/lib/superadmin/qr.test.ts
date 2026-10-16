import { describe, expect, it } from 'vitest';
import { encodeQr, qrSvgPath } from './qr';

// Referencia: la librería `qrcode` 1.5.4 (la que usa el API para el QR del
// saldo), modo byte, corrección M, máscara 2. '#' = módulo oscuro.
const REFERENCE_LOCALHOST_MASK2 = [
  '#######....##..##..##.#######',
  '#.....#..#..#....#..#.#.....#',
  '#.###.#.##.#..#.#..##.#.###.#',
  '#.###.#.#.......####..#.###.#',
  '#.###.#.####.###.###..#.###.#',
  '#.....#.##########....#.....#',
  '#######.#.#.#.#.#.#.#.#######',
  '........##.###.#.............',
  '#.#####..###..##.#..#.#####..',
  '.....#.....##..##.##.####...#',
  '.###..##.####.....#..##.#....',
  '...#...#.#....#.#....#.#...#.',
  '.#.##.#.#.##....##..#....##..',
  '.##....##..#.###..##.####.#.#',
  '#..######..#.######.#.###.#..',
  '#..#.#....####.#..#...#.#..#.',
  '.#.#.###.##.#.##.#..#.....#..',
  '##..#...####...##.##..#####.#',
  '#.#..##.#.##.....##..#.#.##..',
  '#..##...##....#.#...#.#.#..#.',
  '#..#..#...#.#...#.#.#####.###',
  '........#....###.####...#####',
  '#######...##.#####.##.#.###..',
  '#.....#.#.#..#.#.##.#...##..#',
  '#.###.#.##....##....#####.###',
  '#.###.#.####.#.##.#.#....##..',
  '#.###.#.###.......#.#.###..#.',
  '#.....#....#..#.#..##..#.#.#.',
  '#######.###..##.#.#..#.#..#..',
];

const rowsOf = (modules: boolean[][]): string[] => modules.map((row) => row.map((d) => (d ? '#' : '.')).join(''));

describe('encodeQr', () => {
  it('igual que la librería de referencia (módulo a módulo)', () => {
    const qr = encodeQr('http://localhost:4100/w/abc', { mask: 2 });
    expect(qr).not.toBeNull();
    expect(qr?.version).toBe(3);
    expect(qr?.size).toBe(29);
    expect(rowsOf(qr?.modules ?? [])).toEqual(REFERENCE_LOCALHOST_MASK2);
  });

  it('elige la versión mínima en la que cabe', () => {
    expect(encodeQr('x')?.version).toBe(1);
    // Un enlace de saldo real: dominio + /w/ + token de 43 caracteres.
    const link = `https://api.oxiopay.com/w/${'Zx8_kq2Lr0bQ9cVY3mN7pT1wHsD4eF6gJ5uA2yB0oXk'}`;
    expect(encodeQr(link)?.version).toBe(5);
    expect(encodeQr('h'.repeat(400))?.version).toBe(15);
  });

  it('dibuja los tres cuadros de las esquinas', () => {
    const qr = encodeQr('https://api.oxiopay.com/w/abc');
    if (!qr) throw new Error('sin QR');
    const finderTop = ['#######', '#.....#', '#.###.#', '#.###.#', '#.###.#', '#.....#', '#######'];
    const rows = rowsOf(qr.modules);
    expect(rows.slice(0, 7).map((r) => r.slice(0, 7))).toEqual(finderTop);
    expect(rows.slice(0, 7).map((r) => r.slice(-7))).toEqual(finderTop);
    expect(rows.slice(-7).map((r) => r.slice(0, 7))).toEqual(finderTop);
  });

  it('la máscara elegida es una de las 8', () => {
    const qr = encodeQr('https://api.oxiopay.com/w/abc');
    expect(qr?.mask).toBeGreaterThanOrEqual(0);
    expect(qr?.mask).toBeLessThanOrEqual(7);
  });

  it('demasiado largo: null', () => {
    expect(encodeQr('x'.repeat(3000))).toBeNull();
  });
});

describe('qrSvgPath', () => {
  it('un tramo por cada racha oscura de cada fila, con el margen', () => {
    const qr = { size: 3, version: 1, mask: 0, modules: [[true, true, false], [false, false, false], [false, true, true]] };
    expect(qrSvgPath(qr, 4)).toBe('M4 4h2v1h-2zM5 6h2v1h-2z');
  });
});
