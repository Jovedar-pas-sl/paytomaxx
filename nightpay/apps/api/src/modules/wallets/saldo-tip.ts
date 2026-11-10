import { clientMoney, escapeHtml } from '../payments/club-ui';
import type { PayLanguage } from '../payments/customer-lang';
import { PAY_TEXT } from '../payments/pay-i18n';
import type { QrChargeTipView } from './wallet-charges.service';

/**
 * La propina al pagar con el saldo en /s (B1): la elige el cliente, sin
 * nada marcado, como en la página de pago con tarjeta (los mismos botones y
 * textos: PAY_TEXT). «Sin propina», las sugeridas del local para el importe
 * y «Otra» (euros enteros, hasta el máximo). Sale marcada solo la que ya
 * eligió en /pay (?tip=) o la que traía un cobro de antes (puesta por el
 * personal), que se puede quitar.
 */

/** «33 € + 5 € de propina» debajo del importe, cuando eligió una. */
export const SALDO_TIP_LINE: Readonly<Record<PayLanguage, string>> = {
  es: '{base} + {tip} de propina',
  en: '{base} + {tip} tip',
  fr: '{base} + {tip} de pourboire',
  pt: '{base} + {tip} de gorjeta',
};

export const SALDO_TIP_CSS = `
.c fieldset.tips{border:0;margin:0;padding:0;min-width:0;width:100%}
.c .tips legend{width:100%;margin:0 0 .6rem;padding:0;color:var(--fg);font-weight:600;font-size:1rem;text-align:center}
.tipgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(4.25rem,1fr));gap:.5rem}
.tipgrid label{display:block;position:relative}
.tipgrid input{position:absolute;opacity:0;width:1px;height:1px}
.tipgrid span{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.05rem;min-height:3rem;padding:.4rem .25rem;border:1px solid var(--line-hi);border-radius:var(--r-field);background:var(--surface-2);font-family:var(--num);font-size:1rem;font-weight:600;color:var(--fg);cursor:pointer;line-height:1.12;text-align:center;overflow-wrap:anywhere}
.tipgrid span.word{font-family:var(--sans);font-size:.875rem;font-weight:500}
.tipgrid small{font-family:var(--num);font-size:.75rem;font-weight:600;color:var(--mute)}
.tipgrid input:checked+span{border-color:var(--fg);background:var(--fg);color:var(--bg)}
.tipgrid input:checked+span small{color:var(--bg)}
.tipgrid input:focus-visible+span{outline:3px solid var(--fg);outline-offset:3px}
.c .other{display:grid;grid-template-columns:auto auto;justify-content:center;align-items:center;gap:.3rem .7rem;margin-top:.7rem}
.c .other>p{grid-column:1/-1}
.c .other label{font-weight:500;color:var(--fg)}
.c .eur{display:flex;align-items:center;gap:.4rem}
.c .eur input{width:6.5rem;min-height:3.25rem;font-family:var(--num);font-size:1.375rem;font-weight:600;text-align:center;border-radius:var(--r-field);border:1px solid var(--line-hi);background:var(--surface-2);color:var(--fg)}
.c .eur input:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
.c .eur span{font-size:1.375rem;font-weight:600}
.tipline{color:var(--mute);font-variant-numeric:tabular-nums}
.tipnote{margin-top:.65rem;font-size:.875rem;color:var(--mute)}
`;

/** Las propinas que salen como botón: las sugeridas y, si el cobro traía otra (de antes), esa. */
function tipButtons(tip: QrChargeTipView): Array<{ cents: number; percent: number | null }> {
  const list = tip.presets.map((p) => ({ cents: p.cents, percent: p.percent }));
  if (tip.previousCents > 0 && !list.some((p) => p.cents === tip.previousCents)) {
    list.push({ cents: tip.previousCents, percent: null });
  }
  return list.sort((a, b) => a.cents - b.cents);
}

/**
 * La propina marcada al abrir: la que eligió en /pay (`fromPay`, si vale) o
 * la que traía el cobro; si no, ninguna (null: nada marcado).
 */
export function initialSaldoTip(tip: QrChargeTipView, fromPay: number | null): number | null {
  if (fromPay !== null && Number.isInteger(fromPay) && fromPay >= 0) {
    // Un botón («Sin propina», una sugerida o la que traía el cobro) o «Otra» en euros enteros hasta el máximo.
    if (fromPay === 0 || tipButtons(tip).some((b) => b.cents === fromPay)) return fromPay;
    if (fromPay % 100 === 0 && fromPay <= tip.maxCents && tip.maxCents >= 100) return fromPay;
  }
  return tip.previousCents > 0 ? tip.previousCents : null;
}

/** El fieldset de la propina (radios: funciona igual que en /pay; el JS lee la marcada). */
export function saldoTipFieldset(lang: PayLanguage, tip: QrChargeTipView, initial: number | null): string {
  const t = PAY_TEXT[lang];
  const h = escapeHtml;
  const money = (c: number): string => clientMoney(c, t.locale);
  const buttons = tipButtons(tip);
  const isButton = initial !== null && (initial === 0 || buttons.some((b) => b.cents === initial));
  // Otra cantidad (de /pay) que no es un botón: en «Otra», si son euros enteros.
  const otherInitial = initial !== null && !isButton && initial % 100 === 0 ? initial / 100 : null;
  const checked = (cents: number): string => (isButton && initial === cents ? ' checked' : '');
  const pct = (p: number): string => (p / 100).toLocaleString(t.locale, { style: 'percent' });
  const options = buttons
    .map((b) => {
      const label = b.percent
        ? `${h(pct(b.percent))}<small class="num">+${h(money(b.cents))}</small>`
        : `+${h(money(b.cents))}`;
      return `<label><input type="radio" name="tip" value="${b.cents}"${checked(b.cents)}><span class="num">${label}</span></label>`;
    })
    .join('');
  const canOther = tip.maxCents >= 100;
  const maxText = money(Math.floor(tip.maxCents / 100) * 100);
  const other = canOther
    ? `<label><input type="radio" name="tip" value="0" id="otherRadio"${otherInitial !== null ? ' checked' : ''}><span class="word">${h(t.tipOther)}</span></label>`
    : '';
  const otherBox = canOther
    ? `<div class="other" id="otherBox"${otherInitial !== null ? '' : ' hidden'}><label for="otherIn">${h(t.tipOtherLabel)}</label>
<div class="eur"><input id="otherIn" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" enterkeyhint="done" aria-describedby="otherMax otherErr" value="${otherInitial ?? ''}"><span aria-hidden="true">€</span></div>
<p class="small" id="otherMax">${h(t.tipMax(maxText))}</p>
<p class="err" id="otherErr" role="alert" hidden></p></div>`
    : '';
  return `<fieldset class="tips"><legend>${h(t.tipLegend)}</legend><div class="tipgrid">
<label><input type="radio" name="tip" value="0"${checked(0)}><span class="word">${h(t.noTip)}</span></label>${options}${other}</div>
${otherBox}${tip.toStaff ? `<p class="tipnote">${h(t.tipToStaff)}</p>` : ''}</fieldset>`;
}

/** Lo que necesita el JS de /s para la propina (null: sin propinas). */
export function saldoTipConfig(lang: PayLanguage, tip: QrChargeTipView): Record<string, unknown> {
  const t = PAY_TEXT[lang];
  return {
    base: tip.baseCents,
    max: tip.maxCents,
    line: SALDO_TIP_LINE[lang],
    empty: t.tipOtherEmpty,
    tooHigh: t.tipOtherTooHigh(clientMoney(Math.floor(tip.maxCents / 100) * 100, t.locale)),
  };
}
