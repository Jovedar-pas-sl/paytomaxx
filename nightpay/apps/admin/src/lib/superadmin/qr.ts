// Código QR (ISO/IEC 18004) para el enlace nuevo de un saldo, sin
// dependencias: el API de la consola da solo la ruta (/w/<token>) y el panel
// no tiene librería de QR. Modo byte (UTF-8), corrección M (15 %), versión
// mínima que quepa y la máscara con menos penalización. Basado en el
// algoritmo de referencia de Project Nayuki (MIT).

export interface QrMatrix {
  /** Módulos por lado (21 en la versión 1, +4 por versión). */
  size: number;
  version: number;
  mask: number;
  /** modules[y][x]: true = oscuro. */
  modules: boolean[][];
}

// Tablas de la corrección M, por versión (índice 0 sin uso).
const ECC_PER_BLOCK_M = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
const BLOCKS_M = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33,
  35, 37, 38, 40, 43, 45, 47, 49,
];
/** Bits de formato de la corrección M. */
const ECL_M_FORMAT_BITS = 0;
const MIN_VERSION = 1;
const MAX_VERSION = 40;

const tableAt = (table: readonly number[], version: number): number => table[version] ?? 0;
const bitAt = (value: number, index: number): boolean => ((value >>> index) & 1) !== 0;

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8) - tableAt(ECC_PER_BLOCK_M, version) * tableAt(BLOCKS_M, version);
}

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

/** Bits de datos: modo byte, longitud, datos, terminador y relleno. */
function dataBits(bytes: readonly number[], version: number): number[] | null {
  const countBits = version <= 9 ? 8 : 16;
  if (bytes.length >= 1 << countBits) return null;
  const capacity = dataCodewords(version) * 8;
  const bits: number[] = [];
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits);
  for (const b of bytes) push(b, 8);
  if (bits.length > capacity) return null;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  return bits;
}

// ─── Reed-Solomon en GF(2^8), polinomio 0x11D ────────────────────────

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = Array.from({ length: degree }, (_, i): number => (i === degree - 1 ? 1 : 0));
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j] ?? 0, root);
      if (j + 1 < result.length) result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0);
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  let result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result[0] ?? 0);
    result = [...result.slice(1), 0];
    result = result.map((r, i) => r ^ gfMultiply(divisor[i] ?? 0, factor));
  }
  return result;
}

/** Bloques con su corrección, intercalados como manda la norma. */
function withEcc(data: readonly number[], version: number): number[] {
  const numBlocks = tableAt(BLOCKS_M, version);
  const eccLen = tableAt(ECC_PER_BLOCK_M, version);
  const raw = Math.floor(rawDataModules(version) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortLen - eccLen + (i < numShort ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, divisor);
    blocks.push([...dat, ...(i < numShort ? [0] : []), ...ecc]);
  }
  const result: number[] = [];
  const width = blocks[0]?.length ?? 0;
  for (let i = 0; i < width; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) result.push(block[i] ?? 0);
    });
  }
  return result;
}

// ─── Dibujo ─────────────────────────────────────────────────────────

interface Grid {
  size: number;
  modules: boolean[][];
  isFunction: boolean[][];
}

function newGrid(size: number): Grid {
  const blank = (): boolean[][] => Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  return { size, modules: blank(), isFunction: blank() };
}

function setFunction(g: Grid, x: number, y: number, dark: boolean): void {
  const row = g.modules[y];
  const fnRow = g.isFunction[y];
  if (!row || !fnRow) return;
  row[x] = dark;
  fnRow[x] = true;
}

function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function drawFinder(g: Grid, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && x < g.size && y >= 0 && y < g.size) setFunction(g, x, y, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(g: Grid, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) setFunction(g, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
}

function drawFormatBits(g: Grid, mask: number): void {
  const data = (ECL_M_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const size = g.size;
  for (let i = 0; i <= 5; i++) setFunction(g, 8, i, bitAt(bits, i));
  setFunction(g, 8, 7, bitAt(bits, 6));
  setFunction(g, 8, 8, bitAt(bits, 7));
  setFunction(g, 7, 8, bitAt(bits, 8));
  for (let i = 9; i < 15; i++) setFunction(g, 14 - i, 8, bitAt(bits, i));
  for (let i = 0; i < 8; i++) setFunction(g, size - 1 - i, 8, bitAt(bits, i));
  for (let i = 8; i < 15; i++) setFunction(g, 8, size - 15 + i, bitAt(bits, i));
  setFunction(g, 8, size - 8, true);
}

function drawVersion(g: Grid, version: number): void {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = bitAt(bits, i);
    const a = g.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunction(g, a, b, dark);
    setFunction(g, b, a, dark);
  }
}

function drawFunctionPatterns(g: Grid, version: number): void {
  for (let i = 0; i < g.size; i++) {
    setFunction(g, 6, i, i % 2 === 0);
    setFunction(g, i, 6, i % 2 === 0);
  }
  drawFinder(g, 3, 3);
  drawFinder(g, g.size - 4, 3);
  drawFinder(g, 3, g.size - 4);
  const positions = alignmentPositions(version, g.size);
  const last = positions.length - 1;
  positions.forEach((py, i) => {
    positions.forEach((px, j) => {
      const corner = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
      if (!corner) drawAlignment(g, px, py);
    });
  });
  drawFormatBits(g, 0);
  drawVersion(g, version);
}

function drawCodewords(g: Grid, codewords: readonly number[]): void {
  let i = 0;
  const total = codewords.length * 8;
  for (let right = g.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < g.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? g.size - 1 - vert : vert;
        const row = g.modules[y];
        if (row && !g.isFunction[y]?.[x] && i < total) {
          row[x] = bitAt(codewords[i >>> 3] ?? 0, 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

function maskHit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** Aplica (o deshace: es un XOR) la máscara sobre los módulos de datos. */
function applyMask(g: Grid, mask: number): void {
  g.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (!g.isFunction[y]?.[x] && maskHit(mask, x, y)) row[x] = !dark;
    });
  });
}

// ─── Penalización (para elegir la máscara) ──────────────────────────

const N1 = 3;
const N2 = 3;
const N3 = 40;
const N4 = 10;

function finderLike(history: readonly number[]): number {
  const [h0 = 0, n = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0] = history;
  const core = n > 0 && h2 === n && h3 === n * 3 && h4 === n && h5 === n;
  return (core && h0 >= n * 4 && h6 >= n ? 1 : 0) + (core && h6 >= n * 4 && h0 >= n ? 1 : 0);
}

function lineScore(line: readonly boolean[], size: number): number {
  let score = 0;
  let runColor = false;
  let runLength = 0;
  let history = [0, 0, 0, 0, 0, 0, 0];
  const addHistory = (length: number): void => {
    const len = history[0] === 0 ? length + size : length;
    history = [len, ...history.slice(0, 6)];
  };
  for (const dark of line) {
    if (dark === runColor) {
      runLength++;
      if (runLength === 5) score += N1;
      else if (runLength > 5) score++;
    } else {
      addHistory(runLength);
      if (!runColor) score += finderLike(history) * N3;
      runColor = dark;
      runLength = 1;
    }
  }
  if (runColor) {
    addHistory(runLength);
    runLength = 0;
  }
  addHistory(runLength + size);
  return score + finderLike(history) * N3;
}

function penalty(g: Grid): number {
  const { size, modules } = g;
  let score = 0;
  for (let y = 0; y < size; y++) score += lineScore(modules[y] ?? [], size);
  for (let x = 0; x < size; x++) score += lineScore(modules.map((row) => row[x] ?? false), size);
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y]?.[x];
      if (c === modules[y]?.[x + 1] && c === modules[y + 1]?.[x] && c === modules[y + 1]?.[x + 1]) score += N2;
    }
  }
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * N4;
  return score;
}

// ─── Entrada ────────────────────────────────────────────────────────

/**
 * Texto → matriz QR. `mask` fija la máscara (0-7); sin ella se elige la de
 * menos penalización. null si no cabe ni en la versión 40.
 */
export function encodeQr(text: string, options: { mask?: number } = {}): QrMatrix | null {
  const bytes = utf8Bytes(text);
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    const bits = dataBits(bytes, version);
    if (!bits) continue;
    const data = Array.from({ length: bits.length / 8 }, (_, i) =>
      bits.slice(i * 8, i * 8 + 8).reduce((acc, bit) => (acc << 1) | bit, 0),
    );
    const g = newGrid(version * 4 + 17);
    drawFunctionPatterns(g, version);
    drawCodewords(g, withEcc(data, version));
    const mask = options.mask ?? bestMask(g);
    applyMask(g, mask);
    drawFormatBits(g, mask);
    return { size: g.size, version, mask, modules: g.modules };
  }
  return null;
}

function bestMask(g: Grid): number {
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(g, mask);
    drawFormatBits(g, mask);
    const score = penalty(g);
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
    applyMask(g, mask);
  }
  return best;
}

/** Trazado SVG de los módulos oscuros (una "M…h…v…h…z" por tramo de cada fila). */
export function qrSvgPath(qr: QrMatrix, margin: number): string {
  const parts: string[] = [];
  qr.modules.forEach((row, y) => {
    let x = 0;
    while (x < qr.size) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < qr.size && row[x]) x++;
      parts.push(`M${start + margin} ${y + margin}h${x - start}v1h${start - x}z`);
    }
  });
  return parts.join('');
}
