import { escapeHtml } from './club-ui';
import type { PayLanguage } from './customer-lang';
import { PAY_TEXT } from './pay-i18n';
import { confirmationCode, type PayReceiptView } from './pay-redirect';
import { formatDateTime, formatFull, methodLabel } from './public-pay.pages';

/**
 * El justificante por correo (idea 68): lo pide quien pagó desde su
 * justificante (POST /pay/:token/receipt/email) y va en el idioma de la página.
 *
 *  - Asunto sin el local («Tu justificante de 35,00 €»): se ve con el móvil
 *    bloqueado.
 *  - Fecha, a quién se pagó, importes, método SIN dígitos y código. Nunca lo
 *    pedido (decisión del dueño: solo en los justificantes de pantalla), ni un
 *    enlace, ni imágenes. Y «Si no lo has pedido tú, ignora este correo.».
 *  - Texto y HTML; en el HTML todo va escapado.
 *
 * La dirección no se guarda: solo se apunta que se envió (`receipt.emailed`,
 * con el idioma) para el tope de 3 por cobro.
 */

export const RECEIPT_EMAILED_EVENT = 'receipt.emailed';

/** Tope de justificantes por correo de un mismo cobro (solo cuentan los que Resend aceptó). */
export const RECEIPT_EMAIL_MAX = 3;

export interface ReceiptEmail {
  subject: string;
  text: string;
  html: string;
}

export function receiptEmail(r: PayReceiptView, lang: PayLanguage): ReceiptEmail {
  const t = PAY_TEXT[lang];
  const rt = t.receipt;
  const fmt = (c: number): string => formatFull(c, r.currency, t);
  const fee = r.serviceFeeCents ?? 0;
  const total = fmt(r.amountCents + fee + r.tipCents);
  // Sin dígitos de la tarjeta, aunque los haya: el correo puede reenviarse.
  const method = methodLabel(t, r.cardBrand, r.payMethod);
  const rows: Array<[string, string]> = [
    ...(r.authorizedAt ? [[rt.date, formatDateTime(r.authorizedAt, t)] as [string, string]] : []),
    ...(r.venueName ? [[rt.paidTo, r.venueName] as [string, string]] : []),
    [r.topUp ? rt.topUp : rt.amount, fmt(r.amountCents)],
    ...(fee > 0 ? [[rt.serviceFee, fmt(fee)] as [string, string]] : []),
    ...(r.tipCents > 0 ? [[rt.tip, fmt(r.tipCents)] as [string, string]] : []),
    [rt.total, total],
    ...(method ? [[rt.method, method] as [string, string]] : []),
    [rt.code, confirmationCode(r.paymentId)],
  ];
  const h = escapeHtml;
  const text = [rt.title, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', rt.emailIgnore].join('\n');
  const html = `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8"><title>${h(rt.title)}</title></head>
<body style="margin:0;padding:24px;background:#ffffff;color:#111111;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.4">
<h1 style="margin:0 0 16px;font-size:20px">${h(rt.title)}</h1>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:420px">${rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:8px 12px 8px 0;border-bottom:1px solid #dddddd;color:#555555">${h(k)}</td><td style="padding:8px 0;border-bottom:1px solid #dddddd;text-align:right;font-weight:600">${h(v)}</td></tr>`,
    )
    .join('')}</table>
<p style="margin:16px 0 0;color:#555555;font-size:14px">${h(rt.emailIgnore)}</p>
</body></html>`;
  return { subject: rt.emailSubject(total), text, html };
}
