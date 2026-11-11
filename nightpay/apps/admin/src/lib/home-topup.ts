import type { HomeTopUpSettings } from '@nightpay/contracts';
import { formatEur } from './money';

/**
 * «Cargar saldo desde casa» en Ajustes: lo que verá el cliente, en una frase
 * («De 10 € a 300 €, en euros enteros. Paga con Apple Pay, Google Pay o
 * tarjeta, con la comisión del servicio de las recargas (12 %) encima. El
 * saldo no caduca.»), y la página que se imprime con el QR.
 */
export function homeTopUpSummary(s: Pick<HomeTopUpSettings, 'minCents' | 'maxCents' | 'serviceFeeBps'>): string {
  const fee = s.serviceFeeBps && s.serviceFeeBps > 0 ? `, con la comisión del servicio de las recargas (${pct(s.serviceFeeBps)}) encima` : '';
  return `De ${formatEur(s.minCents)} a ${formatEur(s.maxCents)}, en euros enteros. Paga con Apple Pay, Google Pay o tarjeta${fee}. El saldo no caduca.`;
}

function pct(bps: number): string {
  return `${(bps / 100).toLocaleString('es-ES', { maximumFractionDigits: 2 })} %`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** Una hoja para imprimir: el QR grande, para qué sirve y el enlace debajo. */
export function homeTopUpPrintHtml(qrPngDataUrl: string, url: string): string {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Cargar saldo antes de llegar</title>
<style>body{margin:0;font-family:system-ui,sans-serif;color:#1f2c36;text-align:center}main{padding:2.5rem 1.5rem;display:flex;flex-direction:column;align-items:center;gap:1rem}h1{margin:0;font-size:2rem}p{margin:0;font-size:1.1rem}img{width:12cm;height:12cm}small{font-size:.9rem;word-break:break-all}</style>
</head><body><main><h1>Carga tu saldo antes de llegar</h1><p>Escanea el QR, elige cuánto y paga con Apple Pay, Google Pay o tarjeta.</p>
<img src="${escapeHtml(qrPngDataUrl)}" alt="QR para cargar saldo"><small>${escapeHtml(url)}</small></main></body></html>`;
}

/** El cartel de la cola (B16): lo que lee el cliente, con su línea en inglés (como en el móvil del personal). */
export const QUEUE_POSTER_TEXT = {
  title: 'Carga tu saldo mientras esperas',
  titleEn: 'Top up your balance while you wait',
  steps: 'Escanea, elige cuánto y paga. En recepción solo te damos la ficha.',
  stepsEn: 'Scan, choose how much and pay. At reception we just give you your tag.',
} as const;

/**
 * La hoja del cartel de la cola: el título grande, el QR de esta noche y
 * hasta cuándo vale (`validUntilText`, ya en la hora del local). Sin el enlace
 * escrito: el QR vale solo esta noche y no se copia a mano.
 */
export function queuePosterHtml(qrPngDataUrl: string, validUntilText: string): string {
  const t = QUEUE_POSTER_TEXT;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(t.title)}</title>
<style>body{margin:0;font-family:system-ui,sans-serif;color:#1f2c36;text-align:center}main{padding:2.5rem 1.5rem;display:flex;flex-direction:column;align-items:center;gap:1rem}h1{margin:0;font-size:2.4rem}.en{color:#55606a;font-weight:500}p{margin:0;font-size:1.15rem}img{width:13cm;height:13cm}small{font-size:.9rem;color:#55606a}</style>
</head><body><main><h1>${escapeHtml(t.title)}</h1><p class="en" lang="en">${escapeHtml(t.titleEn)}</p>
<img src="${escapeHtml(qrPngDataUrl)}" alt="QR para cargar saldo">
<p>${escapeHtml(t.steps)}</p><p class="en" lang="en">${escapeHtml(t.stepsEn)}</p>
<small>Vale esta noche, hasta ${escapeHtml(validUntilText)}.</small></main></body></html>`;
}
