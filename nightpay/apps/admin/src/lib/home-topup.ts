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
