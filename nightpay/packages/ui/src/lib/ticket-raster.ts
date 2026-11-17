// El ticket dibujado punto a punto para la térmica de 58 mm (48 mm de
// impresión = 384 puntos a 203 ppp) y pasado a órdenes ESC/POS. El mismo
// dibujo sale por RawBT (de un toque, del largo justo) y por el diálogo de
// imprimir de Android (como imagen): lo que se ve en la vista previa es lo que
// sale en el papel. Sin librerías: el lienzo del navegador y bytes.

import { encodeQr } from './qr';
import { ticketDateTime, ticketMoney, type Ticket } from './ticket';

/** El ancho de impresión de la térmica de 58 mm: 48 mm a 203 ppp (8 puntos por mm). */
export const PRINT_WIDTH_DOTS = 384;
/** Margen a los lados, en puntos. */
const PAD = 4;
/** Hueco entre el texto de la izquierda y el importe de la derecha. */
const GAP = 12;
/** Sangría del «12,00 € c/u» bajo una línea con varias unidades. */
const UNIT_INDENT = 28;
/** La letra del aparato (Roboto en Android; en un ordenador, la que tenga). */
const FAMILY = 'Roboto, "Helvetica Neue", Arial, sans-serif';

interface TextStyle {
  size: number;
  bold?: boolean;
}

/** Las letras del papel, en puntos (8 puntos = 1 mm): la de la impresora de serie es 24. */
export const TICKET_STYLES = {
  venue: { size: 38, bold: true },
  title: { size: 26, bold: true },
  meta: { size: 22 },
  body: { size: 25 },
  unit: { size: 21 },
  total: { size: 40, bold: true },
  foot: { size: 21 },
} as const satisfies Record<string, TextStyle>;

/** Lo que hace falta del lienzo (un CanvasRenderingContext2D, o uno de mentira en las pruebas). */
export interface TicketPainter {
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillText(text: string, x: number, y: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  measureText(text: string): { width: number };
}

const fontOf = (s: TextStyle) => `${s.bold ? 'bold ' : ''}${s.size}px ${FAMILY}`;
const lineHeight = (s: TextStyle) => Math.round(s.size * 1.28);

/** Parte un texto en líneas que caben en `max` puntos (por palabras; una palabra larga, a trozos). */
export function wrapText(p: Pick<TicketPainter, 'measureText'>, text: string, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (p.measureText(candidate).width <= max) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    while (p.measureText(line).width > max && line.length > 1) {
      let cut = line.length - 1;
      while (cut > 1 && p.measureText(line.slice(0, cut)).width > max) cut--;
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}

/**
 * Como wrapText, pero con las líneas parejas: «Tarjeta, Apple Pay, / Google Pay
 * o tu saldo» en vez de dejar una palabra sola abajo. Para lo centrado.
 */
export function wrapBalanced(p: Pick<TicketPainter, 'measureText'>, text: string, max: number): string[] {
  const greedy = wrapText(p, text, max);
  if (greedy.length < 2) return greedy;
  let best = greedy;
  let low = max / greedy.length;
  let high = max;
  // El ancho más estrecho que sigue cabiendo en las mismas líneas.
  for (let i = 0; i < 12; i++) {
    const mid = (low + high) / 2;
    const tried = wrapText(p, text, mid);
    if (tried.length <= greedy.length) {
      best = tried;
      high = mid;
    } else {
      low = mid;
    }
  }
  return best;
}

/**
 * Dibuja el ticket y devuelve su alto en puntos. Con `draw` false solo mide
 * (para dar al lienzo el alto justo antes de dibujar: ni un milímetro de más).
 */
export function paintTicket(p: TicketPainter, t: Ticket, width = PRINT_WIDTH_DOTS, draw = true): number {
  const inner = width - PAD * 2;
  let y = 2;
  p.textBaseline = 'top';
  if (draw) p.fillStyle = '#000';

  const centered = (text: string, s: TextStyle) => {
    p.font = fontOf(s);
    for (const line of wrapBalanced(p, text, inner)) {
      if (draw) {
        p.textAlign = 'center';
        p.fillText(line, width / 2, y);
      }
      y += lineHeight(s);
    }
  };

  /** Texto a la izquierda y valor a la derecha, en la misma línea; lo largo baja a la siguiente. */
  const leftRight = (left: string, right: string, s: TextStyle, indent = 0) => {
    p.font = fontOf(s);
    const rightW = right ? p.measureText(right).width : 0;
    const room = Math.max(inner * 0.35, inner - indent - rightW - GAP);
    const lines = wrapText(p, left, room);
    lines.forEach((line, i) => {
      if (draw) {
        p.textAlign = 'left';
        p.fillText(line, PAD + indent, y);
        if (i === 0 && right) {
          p.textAlign = 'right';
          p.fillText(right, width - PAD, y);
        }
      }
      y += lineHeight(s);
    });
  };

  const rule = () => {
    y += 6;
    if (draw) for (let x = PAD; x < width - PAD; x += 10) p.fillRect(x, y, 6, 2);
    y += 10;
  };

  if (t.venue) centered(t.venue, TICKET_STYLES.venue);
  centered(t.title, TICKET_STYLES.title);
  y += 2;
  if (t.number) leftRight(`Nº ${t.number}`, ticketDateTime(t.at), TICKET_STYLES.meta);
  else centered(ticketDateTime(t.at), TICKET_STYLES.meta);
  rule();

  const currency = t.currency ?? 'EUR';
  if (t.lines.length > 0) {
    for (const line of t.lines) {
      leftRight(`${line.qty > 1 ? `${line.qty}× ` : ''}${line.label}`, ticketMoney(line.amountCents, currency), TICKET_STYLES.body);
      if (line.qty > 1 && line.unitCents) leftRight(`${ticketMoney(line.unitCents, currency)} c/u`, '', TICKET_STYLES.unit, UNIT_INDENT);
    }
    rule();
  }
  for (const row of t.amounts) leftRight(row.label, row.value, TICKET_STYLES.body);
  if (t.totalCents !== null) {
    y += 2;
    leftRight('TOTAL', ticketMoney(t.totalCents, currency), TICKET_STYLES.total);
  }

  if (t.payment.length > 0) {
    rule();
    for (const row of t.payment) leftRight(row.label, row.value, TICKET_STYLES.body);
  }

  const qr = t.qrUrl ? encodeQr(t.qrUrl) : null;
  if (qr) {
    // Módulos enteros (sin borrones) y 4 de margen blanco: lo que pide la norma para leerse bien.
    const quiet = 4;
    const module = Math.max(2, Math.floor(Math.min(280, inner) / (qr.size + quiet * 2)));
    const side = module * (qr.size + quiet * 2);
    const x0 = Math.round((width - side) / 2);
    y += 6;
    if (draw) {
      qr.modules.forEach((row, my) =>
        row.forEach((dark, mx) => {
          if (dark) p.fillRect(x0 + (mx + quiet) * module, y + (my + quiet) * module, module, module);
        }),
      );
    }
    y += side;
    if (t.qrNote) centered(t.qrNote, TICKET_STYLES.meta);
  }

  rule();
  for (const line of t.footer) centered(line, TICKET_STYLES.foot);
  return Math.ceil(y + 4);
}

/** El ticket en un lienzo blanco de 384 puntos de ancho y el alto justo. */
export function renderTicketCanvas(t: Ticket, doc: Document = document): HTMLCanvasElement {
  const canvas = doc.createElement('canvas');
  canvas.width = PRINT_WIDTH_DOTS;
  canvas.height = 16;
  const measure = canvas.getContext('2d');
  if (!measure) throw new Error('Este navegador no puede dibujar el ticket.');
  const height = paintTicket(measure, t, PRINT_WIDTH_DOTS, false);
  canvas.height = height;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, PRINT_WIDTH_DOTS, height);
  paintTicket(ctx, t, PRINT_WIDTH_DOTS, true);
  return canvas;
}

/**
 * Píxeles RGBA → un bit por punto (1 = negro), filas de `ceil(ancho / 8)` bytes.
 * Lo transparente cuenta como papel (blanco).
 */
export function rasterBits(rgba: ArrayLike<number>, width: number, height: number, threshold = 140): Uint8Array {
  const bytesPerRow = Math.ceil(width / 8);
  const out = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const alpha = (rgba[i + 3] ?? 255) / 255;
      const lum = (0.299 * (rgba[i] ?? 0) + 0.587 * (rgba[i + 1] ?? 0) + 0.114 * (rgba[i + 2] ?? 0)) * alpha + 255 * (1 - alpha);
      if (lum < threshold) out[y * bytesPerRow + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return out;
}

/** Filas por bloque de imagen: las térmicas baratas tienen poco búfer. */
const BAND_ROWS = 96;
/**
 * Papel que avanza al final, en puntos (8 = 1 mm): lo que hay del cabezal a la
 * sierra, para cortar el ticket sin llevarse la última línea. 15 mm.
 */
export const TAIL_FEED_DOTS = 120;

/**
 * Órdenes ESC/POS: iniciar (ESC @), la imagen por bloques (GS v 0) y avanzar
 * el papel lo justo para cortarlo (ESC J n, en puntos).
 */
export function escPosImage(bits: Uint8Array, width: number, height: number, feedDots = TAIL_FEED_DOTS): Uint8Array {
  const bytesPerRow = Math.ceil(width / 8);
  const parts: number[] = [0x1b, 0x40];
  for (let y0 = 0; y0 < height; y0 += BAND_ROWS) {
    const rows = Math.min(BAND_ROWS, height - y0);
    parts.push(0x1d, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, rows & 0xff, rows >> 8);
    for (let i = y0 * bytesPerRow; i < (y0 + rows) * bytesPerRow; i++) parts.push(bits[i] ?? 0);
  }
  parts.push(0x1b, 0x4a, Math.max(0, Math.min(255, feedDots)));
  return Uint8Array.from(parts);
}

/** Base64 de unos bytes (por trozos: un ticket largo no revienta la pila). */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x4000) s += String.fromCharCode(...bytes.subarray(i, i + 0x4000));
  return btoa(s);
}

/** El paquete de la app RawBT (Play Store): imprime en la térmica lo que se le manda. */
export const RAWBT_PACKAGE = 'ru.a402d.rawbtprinter';

/**
 * El enlace que abre RawBT con los bytes del ticket (sin diálogo). Si RawBT no
 * está instalada, Android abre su ficha en Play Store.
 */
export function rawbtIntentUrl(bytes: Uint8Array): string {
  return `intent:base64,${bytesToBase64(bytes)}#Intent;scheme=rawbt;package=${RAWBT_PACKAGE};end;`;
}

/** El lienzo del ticket → las órdenes para la impresora. */
export function canvasToEscPos(canvas: HTMLCanvasElement): Uint8Array {
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return escPosImage(rasterBits(data, canvas.width, canvas.height), canvas.width, canvas.height);
}
