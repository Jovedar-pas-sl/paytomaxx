import { clientMoney, escapeHtml } from './club-ui';
import type { PayText } from './i18n/types';

/**
 * Los botones de la propina de /pay (con tarjeta) y de /s (con el saldo): una
 * sola copia (idea 66; antes había dos y se separaban).
 *
 *  - Cada sugerida dice los euros («+3 €», 16/600) y, debajo, lo que pagaría
 *    con ella («39,30 €», 14 px): el cliente ve el total antes de tocar. Sin
 *    porcentajes. El lector de pantalla oye «Propina de 3 €. Total 39,30 €».
 *  - «Sin propina» (con su total) y «Otra», en la misma caja. La elegida se ve
 *    invertida y con su ✓ (no solo por el color).
 *  - Rejilla de 4 («Sin propina», más ancha): una quinta pasa a otra fila.
 *    56 px de alto; 48 en pantallas bajas (TIP_BUTTONS_LOW_CSS: cada página lo
 *    mete en su consulta de pantallas bajas).
 *  - Debajo, siempre, a quién va: «Va entera para el personal» o «Es para el
 *    local».
 *
 * El total solo se enseña: lo que se cobra lo decide el servidor al pagar. Son
 * radios de un formulario normal (name="tip", en céntimos): sin JS se elige
 * una sugerida; «Otra» necesita el JS de la página.
 */
export const TIP_BUTTONS_CSS = `
.tips{border:0;margin:0;padding:0;min-width:0;width:100%}
.tips legend{width:100%;margin:0 0 .6rem;padding:0;color:var(--fg);font-weight:600;font-size:1rem;text-align:center}
.tipgrid{display:grid;grid-template-columns:1.35fr 1fr 1fr 1fr;gap:.5rem}
.tipgrid label{display:block;position:relative}
.tipgrid input{position:absolute;opacity:0;width:1px;height:1px}
.tipgrid label>span{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.1rem;min-height:3.5rem;padding:.4rem .25rem;border:1px solid var(--line-hi);border-radius:var(--r-field);background:var(--surface-2);color:var(--fg);cursor:pointer;line-height:1.12;text-align:center;overflow-wrap:anywhere;transition:transform .15s var(--ease)}
.tipgrid b{font-family:var(--num);font-size:1rem;font-weight:600;font-variant-numeric:tabular-nums}
.tipgrid .word b{font-family:var(--sans);font-size:.875rem;font-weight:500}
.tipgrid small{font-family:var(--num);font-size:.875rem;font-weight:600;font-variant-numeric:tabular-nums;color:var(--mute)}
.tipgrid input:checked+span{border-color:var(--fg);background:var(--fg);color:var(--bg)}
.tipgrid input:checked+span small{color:var(--bg)}
.tipgrid input:checked+span::after{content:'';position:absolute;top:-.5rem;right:.375rem;width:1rem;height:1rem;border-radius:50%;box-shadow:0 0 0 2px var(--bg);background:var(--bg) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23F4F2EC' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 13l4 4L19 7'/%3E%3C/svg%3E") center/70% no-repeat}
.tipgrid input:focus-visible+span{outline:3px solid var(--fg);outline-offset:3px}
.tipgrid label>span:active{transform:scale(.97)}
.tips .other{display:grid;grid-template-columns:auto auto;justify-content:center;align-items:center;gap:.3rem .7rem;margin-top:.7rem;text-align:center}
.tips .other>p{grid-column:1/-1}
.tips .other label{font-weight:500;color:var(--fg)}
.tips .eur{display:flex;align-items:center;gap:.4rem}
.tips .eur input{width:6.5rem;min-height:3.25rem;font-family:var(--num);font-size:1.375rem;font-weight:600;text-align:center;border-radius:var(--r-field);border:1px solid var(--line-hi);background:var(--surface-2);color:var(--fg)}
.tips .eur input:focus-visible{outline:3px solid var(--fg);outline-offset:2px;border-color:var(--fg)}
.tips .eur input[aria-invalid=true]{border-color:var(--err)}
.tips .eur span{font-size:1.375rem;font-weight:600}
.tips .other .err{text-align:center}
.tipnote{margin-top:.65rem;font-size:.875rem;color:var(--mute);text-align:center}
.tipscreen{margin:-.2rem 0 .6rem;font-size:.875rem;color:var(--fg);text-align:center}
`;

/** Lo mismo en pantallas bajas (360×740): botones de 48 px, que siguen cabiendo las dos líneas. */
export const TIP_BUTTONS_LOW_CSS = `
.tips legend{margin-bottom:.45rem;font-size:.9375rem}
.tipgrid label>span{min-height:3rem;padding:.3rem .25rem}
.tips .eur input{min-height:3rem}
.tips .other{margin-top:.5rem}
.tipnote{margin-top:.45rem}
.tipscreen{margin-bottom:.45rem}
`;

export interface TipButtonsInput {
  t: PayText;
  currency: string;
  /**
   * Lo que paga sin propina: con tarjeta, el importe y la comisión del
   * servicio; con el saldo, el importe. Cada botón enseña esto más su propina.
   */
  dueCents: number;
  /** Las propinas con botón, sin «Sin propina» (céntimos, de menor a mayor). */
  tipsCents: readonly number[];
  /** Tope de «Otra»; por debajo de 1 € no sale. */
  maxCents: number;
  /** La que sale marcada: 0 es «Sin propina»; null, ninguna. */
  checkedCents: number | null;
  /** «Otra» ya marcada con estos euros (la que eligió en /pay y no es un botón). */
  otherEuros?: number | null;
  /** «Otra» empieza oculta y la enseña el JS: /pay se puede pagar sin JS; /s, no. */
  otherHidden?: boolean;
  /** La propina va entera a una persona del personal; si no, es del local. */
  toStaff: boolean;
  /**
   * La marcada es la que eligió en la pantalla de la barra (idea 66, parte B):
   * encima de las propinas, «En la pantalla elegiste 2 € de propina. Puedes
   * cambiarla o quitarla.». Solo si el servidor lo sabe.
   */
  fromScreen?: boolean;
}

export function tipButtons(a: TipButtonsInput): string {
  const { t } = a;
  const h = escapeHtml;
  const euros = (cents: number): string => clientMoney(cents, t.locale, a.currency);
  const total = (tip: number): string => clientMoney(a.dueCents + tip, t.locale, a.currency, true);
  const checked = (cents: number): string => (a.checkedCents === cents ? ' checked' : '');
  const other = a.otherEuros ?? null;
  // Lo que se ve (los euros y el total) y, aparte, la frase entera para el lector de pantalla.
  const box = (said: string, top: string, tip: number): string =>
    `<span class="sr">${h(said)}</span><b aria-hidden="true">${h(top)}</b><small aria-hidden="true">${h(total(tip))}</small>`;
  const options = a.tipsCents
    .map(
      (c) =>
        `<label><input type="radio" name="tip" value="${c}"${checked(c)}><span class="num">${box(t.tipWithTotal(euros(c), total(c)), `+${euros(c)}`, c)}</span></label>`,
    )
    .join('');
  const canOther = a.maxCents >= 100;
  const maxText = euros(Math.floor(a.maxCents / 100) * 100);
  const screen =
    a.fromScreen && a.checkedCents !== null && a.checkedCents > 0
      ? `<p class="tipscreen" id="tipScreen">${h(t.tipFromScreen(euros(a.checkedCents)))}</p>`
      : a.fromScreen && other !== null && other > 0
        ? `<p class="tipscreen" id="tipScreen">${h(t.tipFromScreen(euros(other * 100)))}</p>`
        : '';
  return `<fieldset class="tips"><legend>${h(t.tipLegend)}</legend>${screen}<div class="tipgrid">
<label><input type="radio" name="tip" value="0"${checked(0)}><span class="word">${box(`${t.noTip}. ${t.total} ${total(0)}`, t.noTip, 0)}</span></label>${options}${
    canOther
      ? `<label${a.otherHidden ? ' id="otherOpt" hidden' : ''}><input type="radio" name="tip" value="0" id="otherRadio"${other !== null ? ' checked' : ''}><span class="word"><b>${h(t.tipOther)}</b></span></label>`
      : ''
  }</div>
${
  canOther
    ? `<div class="other" id="otherBox"${other !== null ? '' : ' hidden'}><label for="otherIn">${h(t.tipOtherLabel)}</label>
<div class="eur"><input id="otherIn" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" enterkeyhint="done" aria-describedby="otherMax otherErr" value="${other ?? ''}"><span aria-hidden="true">€</span></div>
<p class="small" id="otherMax">${h(t.tipMax(maxText))}</p>
<p class="err" id="otherErr" role="alert" hidden></p></div>`
    : ''
}<p class="tipnote">${h(a.toStaff ? t.tipToStaff : t.tipToVenue)}</p></fieldset>`;
}
