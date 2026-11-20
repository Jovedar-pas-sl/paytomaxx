import { escapeHtml } from '../payments/club-ui';

/**
 * Hoja para imprimir las pulseras de OxioParty (GET /v1/admin/party/pulseras/hoja):
 * una etiqueta por pulsera con su número grande («P-0412») y su QR (el mismo
 * enlace que lleva el chip: el asistente lo escanea con la cámara y llega a
 * su saldo). A4, 4 por fila; en pantalla, la misma rejilla. HTML
 * autocontenido, sin scripts ni nada de fuera (el panel la abre en una
 * pestaña y se imprime o se guarda en PDF). Colores de día, tinta sobre blanco.
 */

export interface PrintablePulsera {
  label: string;
  /** El QR en SVG (de la librería qrcode, sin nada del usuario). */
  qrSvg: string;
}

export interface PulseraSheetInput {
  brand: string;
  venueName: string;
  pulseras: ReadonlyArray<PrintablePulsera>;
  /** «Para ver tu saldo, escanéalo»: lo que va debajo del QR. */
  hint?: string;
}

const SHEET_CSS = `
:root{--bg:#F3F1EC;--surface:#FFFFFF;--line:#E0DBD1;--fg:#14181B;--fg-2:#3F474E;--fg-3:#5C656D;--coral:#FF7A59}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:400 14px/1.4 'Instrument Sans','Segoe UI',Arial,sans-serif}
header{max-width:190mm;margin:0 auto;padding:16px 0 12px;display:flex;justify-content:space-between;align-items:baseline;gap:12px}
header h1{margin:0;font:800 20px/1.1 Manrope,'Segoe UI',Arial,sans-serif;letter-spacing:-.02em;display:flex;align-items:center;gap:6px}
header h1 i{width:8px;height:8px;border-radius:50%;background:var(--coral);display:inline-block}
header p{margin:0;color:var(--fg-2)}
.grid{max-width:190mm;margin:0 auto 24px;display:grid;grid-template-columns:repeat(4,1fr);gap:4mm}
.tag{background:var(--surface);border:1px solid var(--line);border-radius:3mm;padding:3mm;display:flex;flex-direction:column;align-items:center;gap:1.5mm;break-inside:avoid;page-break-inside:avoid}
.tag .b{font:700 9px/1 Manrope,'Segoe UI',Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:var(--fg-3)}
.tag .n{font:800 22px/1 Manrope,'Segoe UI',Arial,sans-serif;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.tag .q{width:30mm;height:30mm}
.tag .q svg{display:block;width:100%;height:100%}
.tag .h{font-size:8px;color:var(--fg-3);text-align:center}
.tip{max-width:190mm;margin:0 auto 12px;color:var(--fg-3)}
@page{size:A4;margin:10mm}
@media print{body{background:#fff}header{padding-top:0}.tip{display:none}.tag{border-color:#B9B2A5}}
`;

export function renderPulseraSheet(input: PulseraSheetInput): string {
  const h = escapeHtml;
  const hint = input.hint ?? 'Escanéalo para ver tu saldo';
  const n = input.pulseras.length;
  const range = n === 0 ? 'Sin pulseras' : n === 1 ? input.pulseras[0]!.label : `${input.pulseras[0]!.label} a ${input.pulseras[n - 1]!.label} · ${n} pulseras`;
  const tags = input.pulseras
    .map(
      (p) => `<div class="tag"><span class="b">${h(input.brand)}</span><span class="n">${h(p.label)}</span><div class="q" role="img" aria-label="QR de ${h(p.label)}">${p.qrSvg}</div><span class="h">${h(hint)}</span></div>`,
    )
    .join('\n');
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${h(`Pulseras ${range}`)}</title><style>${SHEET_CSS}</style></head>
<body><header><h1>${h(input.brand)}<i aria-hidden="true"></i></h1><p>${h(input.venueName)} · ${h(range)}</p></header>
<p class="tip">Para imprimirla: Ctrl + P (o «Compartir → Imprimir» en el móvil). Cada QR lleva el mismo enlace que el chip de su pulsera: no la enseñes antes de darla.</p>
<main class="grid">
${tags}
</main></body></html>`;
}
