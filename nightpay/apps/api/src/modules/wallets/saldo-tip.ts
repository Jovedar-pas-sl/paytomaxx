import { clientMoney } from '../payments/club-ui';
import type { PayLanguage } from '../payments/customer-lang';
import { PAY_TEXT } from '../payments/pay-i18n';
import { TIP_BUTTONS_CSS, TIP_BUTTONS_LOW_CSS, tipButtons } from '../payments/tip-buttons';
import type { QrChargeTipView } from './wallet-charges.service';

/**
 * La propina al pagar con el saldo en /s (B1): la elige el cliente, sin
 * nada marcado, con los mismos botones y textos que la página de pago con
 * tarjeta (payments/tip-buttons.ts). «Sin propina», las sugeridas del local
 * para el importe y «Otra» (euros enteros, hasta el máximo). Sale marcada solo
 * la que ya eligió en /pay (?tip=) o la que traía un cobro de antes (puesta
 * por el personal), que se puede quitar. Con el saldo no hay comisión del
 * servicio: el total de cada botón es el importe más su propina.
 */

/** «33 € + 5 € de propina» debajo del importe, cuando eligió una. */
export const SALDO_TIP_LINE: Readonly<Record<PayLanguage, string>> = {
  es: '{base} + {tip} de propina',
  en: '{base} + {tip} tip',
  fr: '{base} + {tip} de pourboire',
  pt: '{base} + {tip} de gorjeta',
};

export const SALDO_TIP_CSS = `${TIP_BUTTONS_CSS}.tipline{color:var(--mute);font-variant-numeric:tabular-nums}
@media (max-height:780px){${TIP_BUTTONS_LOW_CSS}}`;

/** Las propinas que salen como botón (céntimos): las sugeridas y, si el cobro traía otra (de antes), esa. */
function buttonTips(tip: QrChargeTipView): number[] {
  return [...new Set([...tip.presets.map((p) => p.cents), ...(tip.previousCents > 0 ? [tip.previousCents] : [])])].sort((a, b) => a - b);
}

/**
 * La propina marcada al abrir: la que eligió en /pay (`fromPay`, si vale) o
 * la que traía el cobro; si no, ninguna (null: nada marcado).
 */
export function initialSaldoTip(tip: QrChargeTipView, fromPay: number | null): number | null {
  if (fromPay !== null && Number.isInteger(fromPay) && fromPay >= 0) {
    // Un botón («Sin propina», una sugerida o la que traía el cobro) o «Otra» en euros enteros hasta el máximo.
    if (fromPay === 0 || buttonTips(tip).includes(fromPay)) return fromPay;
    if (fromPay % 100 === 0 && fromPay <= tip.maxCents && tip.maxCents >= 100) return fromPay;
  }
  return tip.previousCents > 0 ? tip.previousCents : null;
}

/** El fieldset de la propina (radios: funciona igual que en /pay; el JS lee la marcada). */
export function saldoTipFieldset(lang: PayLanguage, tip: QrChargeTipView, initial: number | null): string {
  const buttons = buttonTips(tip);
  const isButton = initial !== null && (initial === 0 || buttons.includes(initial));
  return tipButtons({
    t: PAY_TEXT[lang],
    currency: 'EUR',
    dueCents: tip.baseCents,
    tipsCents: buttons,
    maxCents: tip.maxCents,
    checkedCents: isButton ? initial : null,
    // Otra cantidad (de /pay) que no es un botón: en «Otra», si son euros enteros.
    otherEuros: initial !== null && !isButton && initial % 100 === 0 ? initial / 100 : null,
    toStaff: tip.toStaff,
  });
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
