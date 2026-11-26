import type { PartyRefundMethod } from '@nightpay/contracts';
import type { SendEmailInput } from '../../common/email/email.service';
import { escapeHtml } from '../payments/club-ui';
import { eurPlain } from '../../common/money/eur';

/**
 * El justificante de «Lo que sobra» por correo (si el asistente lo dejó):
 * al pedirla (o al donar) y cuando el organizador la hace. Sin datos de la
 * tarjeta ni el IBAN entero: el importe, la vía, la pulsera y la fecha.
 */

export type RefundMailKind = 'asked' | 'done';

export interface RefundMailInput {
  kind: RefundMailKind;
  to: string;
  brand: string;
  venueName: string;
  method: PartyRefundMethod;
  amountCents: number;
  pulsera: string | null;
  ibanHint: string | null;
  at: Date;
}

const DAY = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'long', year: 'numeric' });

function lines(i: RefundMailInput): { subject: string; body: string[] } {
  const amount = eurPlain(i.amountCents);
  const where = i.pulsera ? `Pulsera ${i.pulsera} · ${i.venueName}` : i.venueName;
  if (i.method === 'DONATE') {
    return {
      subject: `Gracias: ${amount} para la comisión de fiestas`,
      body: [`Has donado ${amount} de lo que te sobraba a la comisión de fiestas.`, where, DAY.format(i.at)],
    };
  }
  const how = i.method === 'CARD' ? 'a la tarjeta con la que cargaste' : `por transferencia a ${i.ibanHint ?? 'tu cuenta'}`;
  if (i.kind === 'asked') {
    return {
      subject: `Pedido: te devolvemos ${amount}`,
      body: [
        `Has pedido que te devolvamos ${amount} ${how}.`,
        'Lo hace el organizador desde su banco: te avisamos por aquí cuando salga.',
        where,
        DAY.format(i.at),
      ],
    };
  }
  return {
    subject: `Hecho: ${amount} de vuelta`,
    body: [
      `El organizador ya te ha devuelto ${amount} ${how}.`,
      i.method === 'CARD' ? 'Según tu banco, puede tardar unos días en verse en tu tarjeta.' : 'Según tu banco, puede tardar uno o dos días en llegar.',
      where,
      DAY.format(i.at),
    ],
  };
}

export function refundMail(i: RefundMailInput): SendEmailInput {
  const { subject, body } = lines(i);
  const html = `<!DOCTYPE html><html lang="es"><body style="margin:0;padding:24px;background:#F3F1EC;color:#14181B;font-family:Arial,sans-serif">
<p style="margin:0 0 16px;font-size:20px;font-weight:700">${escapeHtml(i.brand)}</p>
${body.map((p, n) => `<p style="margin:0 0 10px;font-size:${n === 0 ? 17 : 15}px;line-height:1.45;color:${n === 0 ? '#14181B' : '#3F474E'}">${escapeHtml(p)}</p>`).join('\n')}
</body></html>`;
  return { to: i.to, subject: `${i.brand} · ${subject}`, html, text: body.join('\n') };
}
