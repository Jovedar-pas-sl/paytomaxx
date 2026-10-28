import {
  OXIOPAY_SETTLEMENT_LABEL,
  SETTLEMENT_CONCEPTS,
  SETTLEMENT_CONCEPT_HELP,
  SETTLEMENT_CONCEPT_LABELS,
  SETTLEMENT_STATUS_LABELS,
  formatIbanGroups,
  formatMoney,
  settlementNightLabel,
  settlementWeekLabel,
  type SettlementConcept,
  type SettlementDetail,
} from '@nightpay/contracts';
import { escapeHtml } from '../payments/club-ui';
import { code, money, text, toCsv, type CsvCell } from '../reports/csv';

/**
 * El documento de una «Liquidación OxioPay»: una página HTML preparada para
 * imprimir o guardar como PDF (Imprimir → Guardar como PDF; sin librerías de
 * PDF) y su CSV. Es un resumen de lo que el local debe a OxioPay, NO una
 * factura. Todo lo escrito por personas va escapado.
 */

const LONG_FMT = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const DATE_FMT = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'long', year: 'numeric' });

const e = (s: string): string => escapeHtml(s);
const eur = (cents: number): string => e(formatMoney(cents));

/** «26/10/2026» de un día AAAA-MM-DD. */
function dmy(day: string): string {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

export function settlementFileName(d: Pick<SettlementDetail, 'reference'>, ext: 'html' | 'csv'): string {
  return `liquidacion-oxiopay-${d.reference}.${ext}`;
}

/** Los conceptos con algo en la semana o en los ajustes (los demás no ocupan sitio). */
function usedConcepts(d: SettlementDetail): SettlementConcept[] {
  return SETTLEMENT_CONCEPTS.filter(
    (c) => d.byConcept[c] !== 0 || d.nights.some((n) => n.concepts[c] !== 0) || d.adjustments.some((a) => a.concept === c),
  );
}

function partiesHtml(d: SettlementDetail): string {
  const p = d.party;
  const business = [
    p.businessName ? `<p>Razón social: <strong>${e(p.businessName)}</strong></p>` : '',
    p.businessTaxId ? `<p>NIF/CIF: <strong>${e(p.businessTaxId)}</strong></p>` : '',
  ].join('');
  return `<section class="parties">
  <div><h2>De</h2><p><strong>${e(d.payee?.name ?? 'OxioPay')}</strong></p><p>Comisión del servicio y de plataforma</p></div>
  <div><h2>Para</h2><p><strong>${e(p.venueName)}</strong></p>${business}</div>
  <div><h2>Periodo</h2><p><strong>${e(settlementWeekLabel(d))}</strong></p>
    <p>Del ${e(LONG_FMT.format(new Date(d.periodFrom)))}<br>al ${e(LONG_FMT.format(new Date(d.periodTo)))} (hora de Madrid)</p>
    <p>Emitida el ${e(DATE_FMT.format(new Date(d.generatedAt)))}</p></div>
</section>`;
}

function summaryHtml(d: SettlementDetail, concepts: readonly SettlementConcept[]): string {
  const rows = concepts
    .map(
      (c) =>
        `<tr><th scope="row">${e(SETTLEMENT_CONCEPT_LABELS[c])}<span class="help">${e(SETTLEMENT_CONCEPT_HELP[c])}</span></th><td>${eur(d.byConcept[c])}</td></tr>`,
    )
    .join('');
  return `<section><h2>Resumen</h2><table class="sum">
<tbody>${rows || '<tr><td colspan="2">Sin movimientos.</td></tr>'}</tbody>
<tfoot>
<tr><th scope="row">Total de la semana</th><td>${eur(d.periodCents)}</td></tr>
<tr><th scope="row">Ajustes de semanas anteriores</th><td>${eur(d.adjustmentsCents)}</td></tr>
<tr class="total"><th scope="row">Total a pagar</th><td>${eur(d.totalCents)}</td></tr>
<tr><th scope="row">Pagado</th><td>${eur(d.paidCents)}</td></tr>
<tr class="pending"><th scope="row">Pendiente</th><td>${eur(d.pendingCents)}</td></tr>
</tfoot></table></section>`;
}

function nightsHtml(d: SettlementDetail, concepts: readonly SettlementConcept[]): string {
  const head = concepts.map((c) => `<th scope="col">${e(SETTLEMENT_CONCEPT_LABELS[c])}</th>`).join('');
  const rows = d.nights
    .map(
      (n) =>
        `<tr><th scope="row">${e(settlementNightLabel(n.day))}</th>${concepts.map((c) => `<td>${eur(n.concepts[c])}</td>`).join('')}<td><strong>${eur(n.totalCents)}</strong></td></tr>`,
    )
    .join('');
  return `<section><h2>Por noche</h2><p class="note">Cada noche, de 08:00 a 08:00 del día siguiente.</p>
<div class="scroll"><table class="grid"><thead><tr><th scope="col">Noche</th>${head}<th scope="col">Total</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><th scope="row">Semana</th>${concepts.map((c) => `<td>${eur(d.nights.reduce((a, n) => a + n.concepts[c], 0))}</td>`).join('')}<td><strong>${eur(d.periodCents)}</strong></td></tr></tfoot>
</table></div></section>`;
}

function adjustmentsHtml(d: SettlementDetail): string {
  if (d.adjustments.length === 0) {
    return `<section><h2>Ajustes de semanas anteriores</h2><p class="note">Ninguno: nada se apuntó tarde en semanas ya liquidadas.</p></section>`;
  }
  const rows = d.adjustments
    .map(
      (a) =>
        `<tr><td>${e(settlementWeekLabel(a))}${a.reference ? `<span class="help">${e(a.reference)}</span>` : ''}</td><td>${e(settlementNightLabel(a.day))}</td><td>${e(SETTLEMENT_CONCEPT_LABELS[a.concept])}</td><td>${eur(a.amountCents)}</td></tr>`,
    )
    .join('');
  return `<section><h2>Ajustes de semanas anteriores</h2>
<p class="note">Lo apuntado después de liquidar esas semanas, con la fecha de entonces (p. ej. una devolución del banco).</p>
<table class="grid"><thead><tr><th scope="col">Semana</th><th scope="col">Noche</th><th scope="col">Concepto</th><th scope="col">Importe</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><th scope="row" colspan="3">Total de los ajustes</th><td><strong>${eur(d.adjustmentsCents)}</strong></td></tr></tfoot></table></section>`;
}

function payHtml(d: SettlementDetail): string {
  if (d.status === 'VOID') {
    return `<section class="pay void"><h2>Anulada</h2><p><strong>No hay que pagarla.</strong> OxioPay la ha anulado; si hace falta, emitirá otra.</p></section>`;
  }
  if (d.status === 'PAID') {
    return `<section class="pay"><h2>Pagada</h2><p>Recibido entero: ${eur(d.paidCents)}. Gracias.</p></section>`;
  }
  if (!d.payee) {
    return `<section class="pay warn"><h2>Cómo pagar</h2><p><strong>OxioPay aún no ha puesto la cuenta para la transferencia.</strong> Pídesela a OxioPay; el importe y la referencia son estos:</p>
<dl><div><dt>Importe</dt><dd>${eur(d.pendingCents)}</dd></div><div><dt>Concepto de la transferencia</dt><dd class="mono">${e(d.reference)}</dd></div></dl></section>`;
  }
  return `<section class="pay"><h2>Cómo pagar</h2><p>Por transferencia bancaria, con la referencia como concepto (así se casa sola con esta liquidación).</p>
<dl>
<div><dt>Titular</dt><dd>${e(d.payee.holder)}</dd></div>
<div><dt>IBAN</dt><dd class="mono">${e(formatIbanGroups(d.payee.iban))}</dd></div>
<div><dt>Concepto de la transferencia</dt><dd class="mono">${e(d.reference)}</dd></div>
<div><dt>Importe</dt><dd><strong>${eur(d.pendingCents)}</strong></dd></div>
</dl><p class="note">Cuenta de OxioPay puesta o cambiada el ${e(DATE_FMT.format(new Date(d.payee.updatedAt)))}. Si no te cuadra, pregunta a OxioPay antes de transferir.</p></section>`;
}

function paymentsHtml(d: SettlementDetail): string {
  if (d.payments.length === 0) return '';
  const rows = d.payments
    .map(
      (p) =>
        `<tr><td>${e(dmy(p.paidOn))}</td><td class="mono">${e(p.bankReference)}</td><td>${eur(p.amountCents)}</td></tr>`,
    )
    .join('');
  return `<section><h2>Pagos recibidos</h2><table class="grid"><thead><tr><th scope="col">Día</th><th scope="col">Referencia del banco</th><th scope="col">Importe</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

const CSS = `
:root{color-scheme:light;--ink:#1f2c36;--mute:#5b6770;--line:#d8dde1;--soft:#f4f6f7;--lime:#c7d301}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
main{max-width:58rem;margin:0 auto;padding:2rem 1.25rem 3rem}
.top{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;border-bottom:3px solid var(--ink);padding-bottom:1rem}
.kicker{margin:0;text-transform:uppercase;letter-spacing:.08em;font-size:.75rem;font-weight:700;color:var(--mute)}
h1{margin:.25rem 0;font-size:1.75rem;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
h2{margin:0 0 .5rem;font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:var(--mute)}
.sub{margin:0;color:var(--mute)}
.badge{border:2px solid var(--ink);border-radius:999px;padding:.25rem .75rem;font-weight:700;white-space:nowrap}
.badge[data-status=VOID]{border-color:#b42318;color:#b42318}
.badge[data-status=PAID]{background:var(--ink);color:#fff}
section{margin-top:1.75rem}
.parties{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:1rem}
.parties div{background:var(--soft);border-radius:.5rem;padding:.85rem 1rem}
.parties p{margin:.15rem 0}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:.45rem .5rem;border-bottom:1px solid var(--line);text-align:right;vertical-align:top}
th:first-child,td:first-child{text-align:left}
thead th{font-size:.75rem;color:var(--mute);font-weight:600}
.sum th{font-weight:500}
.sum tfoot th,.sum tfoot td{border-bottom:0}
.sum .total th,.sum .total td{font-size:1.15rem;font-weight:800;border-top:2px solid var(--ink)}
.sum .pending td{font-weight:700}
.help{display:block;font-size:.8rem;color:var(--mute);font-weight:400}
.grid tfoot th,.grid tfoot td{border-top:2px solid var(--ink);border-bottom:0}
.grid tbody th:first-child{white-space:nowrap}
.scroll{overflow-x:auto}
.note{margin:0 0 .5rem;color:var(--mute);font-size:.875rem}
.pay{border:2px solid var(--ink);border-radius:.75rem;padding:1rem 1.25rem}
.pay.warn{border-color:#b54708;background:#fffaeb}
.pay.void{border-color:#b42318;background:#fef3f2}
.pay p{margin:.25rem 0 .75rem}
dl{margin:0;display:grid;gap:.5rem}
dl div{display:flex;justify-content:space-between;gap:1rem;border-bottom:1px solid var(--line);padding-bottom:.4rem}
dt{color:var(--mute)}
dd{margin:0;font-weight:600;text-align:right;overflow-wrap:anywhere}
.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.02em}
footer{margin-top:2rem;color:var(--mute);font-size:.8rem;display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:center}
button{font:inherit;font-weight:700;padding:.6rem 1.1rem;border-radius:.5rem;border:2px solid var(--ink);background:var(--lime);color:var(--ink);cursor:pointer}
@page{size:A4;margin:14mm}
@media print{main{padding:0;max-width:none}.noprint{display:none!important}.scroll{overflow:visible}section{break-inside:avoid}}
`;

/** La página para imprimir / guardar como PDF. */
export function settlementDocumentHtml(d: SettlementDetail, now: Date): string {
  const concepts = usedConcepts(d);
  const status = SETTLEMENT_STATUS_LABELS[d.status];
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(OXIOPAY_SETTLEMENT_LABEL)} ${e(d.reference)}</title><style>${CSS}</style></head>
<body><main>
<header class="top"><div><p class="kicker">${e(OXIOPAY_SETTLEMENT_LABEL)}</p><h1 class="mono">${e(d.reference)}</h1>
<p class="sub">Resumen de lo que el local debe a OxioPay esta semana. No es una factura.</p></div>
<span class="badge" data-status="${e(d.status)}">${e(status)}</span></header>
${partiesHtml(d)}
${summaryHtml(d, concepts)}
${payHtml(d)}
${nightsHtml(d, concepts)}
${adjustmentsHtml(d)}
${paymentsHtml(d)}
<footer><span>Es lo que el mapa del dinero pone como de OxioPay en esta semana (${eur(d.moneyMapCents)} al emitirla). Generado el ${e(LONG_FMT.format(now))}.</span>
<button type="button" class="noprint" id="print">Imprimir o guardar en PDF</button></footer>
</main>
<script>document.getElementById('print').addEventListener('click',function(){window.print();});</script>
</body></html>`;
}

/** CSV (Excel en español): una fila por noche y concepto con importe, los ajustes y los totales. */
export function settlementCsv(d: SettlementDetail): string {
  const lead = (): CsvCell[] => [code(d.reference), text(d.party.venueName)];
  const header: CsvCell[] = ['Referencia', 'Local', 'Parte', 'Semana', 'Noche', 'Concepto', 'Importe'];
  const rows: CsvCell[][] = [header];
  for (const n of d.nights) {
    for (const c of SETTLEMENT_CONCEPTS) {
      if (n.concepts[c] === 0) continue;
      rows.push([...lead(), 'Semana', dmy(d.nights[0]?.day ?? n.day), dmy(n.day), SETTLEMENT_CONCEPT_LABELS[c], money(n.concepts[c])]);
    }
  }
  for (const a of d.adjustments) {
    rows.push([...lead(), `Ajuste de la semana ${a.isoWeek}`, dmy(a.weekFrom), dmy(a.day), SETTLEMENT_CONCEPT_LABELS[a.concept], money(a.amountCents)]);
  }
  const total = (label: string, cents: number): CsvCell[] => [...lead(), label, '', '', '', money(cents)];
  rows.push(
    total('Total de la semana', d.periodCents),
    total('Ajustes de semanas anteriores', d.adjustmentsCents),
    total('Total a pagar', d.totalCents),
    total('Pagado', d.paidCents),
    total('Pendiente', d.pendingCents),
  );
  return toCsv(rows);
}
