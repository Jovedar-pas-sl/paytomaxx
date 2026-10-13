import { Controller, Get, Inject, Logger, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { PaymentsService } from './payments.service';
import {
  CLOSED_REASON,
  PAID_STATES,
  confirmationCode,
  type PayClosedReason,
  type PayResultView,
} from './pay-redirect';

/**
 * Endpoint público `/pay/:token` (FUERA del prefijo /v1) — el cliente
 * escanea el QR y llega aquí.
 *
 * Según lo que devuelva `resolveRedirect()`:
 *  - `redirect` (Paytef) → HTTP 302 a la URL hosted del PSP
 *  - `form` (Redsys, Cecabank) → HTML con `<form>` auto-submit POST
 *  - `paid` → página "Pagado" (un QR cobrado nunca vuelve al banco)
 *  - `processing` → "comprobando con el banco", se refresca sola
 *  - `closed` → caducado / fallido / sin confirmar
 *
 * `/pay/result?op=<pedido>` es donde vuelve el cliente desde el banco
 * (URLOK/URLKO). Muestra el estado REAL del pago leído de la base de datos;
 * el parámetro `status` de la URL se ignora: cualquiera puede escribirlo.
 *
 * Los textos son para el cliente: discretos y sin nombres internos.
 */
@Controller('pay')
export class PublicPayController {
  private readonly logger = new Logger(PublicPayController.name);
  private readonly payments: PaymentsService;

  constructor(@Inject(PaymentsService) payments: PaymentsService) {
    this.payments = payments;
  }

  @Public()
  @Get('result')
  async paymentResult(@Query('op') op: string | undefined, @Res() res: FastifyReply): Promise<void> {
    const view = op ? await this.payments.getResultView(op) : null;
    sendHtml(res, 200, renderResultView(view));
  }

  @Public()
  @Get(':token')
  async redirect(@Param('token') token: string, @Res() res: FastifyReply): Promise<void> {
    try {
      const result = await this.payments.resolveRedirect(token);
      switch (result.kind) {
        case 'redirect':
          // Paytef u otros PSPs con URL hosted → 302
          res.status(302).header('Location', result.url).send();
          return;
        case 'form':
          sendHtml(res, 200, renderCheckoutForm(result.action, result.fields));
          return;
        case 'paid':
          sendHtml(
            res,
            200,
            renderPaidPage({
              amountCents: result.amountCents,
              currency: result.currency,
              code: confirmationCode(result.paymentId),
              authorizedAt: result.authorizedAt,
            }),
          );
          return;
        case 'processing':
          sendHtml(res, 200, renderProcessingPage(5, true));
          return;
        case 'closed':
          sendHtml(res, 409, renderClosedPage(result.reason));
          return;
      }
    } catch (err) {
      const message = (err as Error).message || 'Error';
      // Logueamos detalles técnicos pero NO los mostramos al cliente
      this.logger.warn(`/pay/${token} redirect failed: ${message}`);
      sendHtml(res, 409, renderMessagePage('Cobro no disponible', humanizePayError(message), 'warn'));
    }
  }
}

function sendHtml(res: FastifyReply, status: number, html: string): void {
  res
    .status(status)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .send(html);
}

function renderResultView(view: PayResultView | null): string {
  if (!view) {
    return renderMessagePage(
      'No encontramos este pago',
      'Si te han cobrado, enséñale el cargo de tu app del banco al personal.',
      'warn',
    );
  }
  if (PAID_STATES.has(view.status)) {
    return renderPaidPage({
      amountCents: view.amountCents,
      currency: view.currency,
      code: confirmationCode(view.paymentId),
      authorizedAt: view.authorizedAt,
    });
  }
  const closed = CLOSED_REASON[view.status];
  if (closed) return renderClosedPage(closed);
  if (view.attemptStatus === 'DENIED') {
    return renderMessagePage(
      'El banco no ha aceptado el pago',
      'No se te ha cobrado. Puedes probar con otra tarjeta o con Apple Pay / Google Pay.',
      'error',
      { href: `/pay/${encodeURIComponent(view.qrToken)}`, label: 'Probar otra vez' },
    );
  }
  return renderProcessingPage(3);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

function formatAmount(cents: number, currency: string): string {
  return (cents / 100).toLocaleString('es-ES', { style: 'currency', currency });
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('es-ES', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Mapea mensajes técnicos de excepción a frases pensadas para un cliente
 * con prisa a las 3am. NO devolver detalles que filtren estructura interna.
 */
function humanizePayError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('expired') || m.includes('expirado') || m.includes('caduca')) {
    return 'Este cobro ha caducado. Pide uno nuevo al personal.';
  }
  if (m.includes('not found') || m.includes('no encontrado')) {
    return 'Este cobro ya no existe. Pide uno nuevo al personal.';
  }
  if (m.includes('already') || m.includes('in progress')) {
    return 'Este cobro ya se está procesando. Espera unos segundos y vuelve a escanear.';
  }
  if (m.includes('gateway') || m.includes('pasarela') || m.includes('redsys') || m.includes('sis')) {
    return 'El banco no responde ahora mismo. Vuelve a escanear el código en unos segundos.';
  }
  return 'No se ha podido continuar con el cobro. Pide uno nuevo al personal.';
}

const CLOSED_TEXT: Record<PayClosedReason, { title: string; body: string }> = {
  expired: { title: 'Este cobro ha caducado', body: 'No se te ha cobrado. Pide uno nuevo al personal.' },
  failed: { title: 'Este cobro no se completó', body: 'No se te ha cobrado. Pide uno nuevo al personal.' },
  canceled: { title: 'Este cobro se ha cancelado', body: 'No se te ha cobrado.' },
  unconfirmed: {
    title: 'Sin confirmación del banco',
    body: 'Si ves el cargo en tu app del banco, enséñaselo al personal y lo resuelven.',
  },
  'too-many-attempts': {
    title: 'Demasiados intentos',
    body: 'Este código ya no admite más intentos. Pide un cobro nuevo al personal.',
  },
};

function renderClosedPage(reason: PayClosedReason): string {
  const t = CLOSED_TEXT[reason];
  return renderMessagePage(t.title, t.body, reason === 'canceled' ? 'neutral' : 'warn');
}

// ─── Páginas ────────────────────────────────────────────────────────────
// Look "Club": negro + lima, letra grande. HTML autocontenido (sin fuentes
// externas: la CSP del API no las permite y el cliente puede tener mala red).

const BASE_CSS = `
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;padding:1.5rem;background:#0b0b0b;color:#f5f5f0;display:grid;place-items:center;min-height:100vh;font-size:18px}
main{max-width:24rem;width:100%;text-align:center;display:flex;flex-direction:column;align-items:center;gap:.75rem}
h1{font-size:2rem;line-height:1.1;margin:0}
p{color:#b4b4ac;line-height:1.5;margin:0}
.btn{display:block;width:100%;margin-top:1rem;padding:1rem;border-radius:10px;background:#d4ff3a;color:#0b0b0b;font-weight:800;text-decoration:none;font-size:1.05rem}
.footer{margin-top:2rem;font-size:.8rem;color:#8a8a83}
`;

function page(title: string, body: string, extraHead = ''): string {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>${extraHead}
<style>${BASE_CSS}</style>
</head><body><main>
${body}
<div class="footer">Pago seguro</div>
</main></body></html>`;
}

function renderPaidPage(args: {
  amountCents: number;
  currency: string;
  code: string;
  authorizedAt: Date | null;
}): string {
  const confirmedAt = args.authorizedAt
    ? `<p>Confirmado por el banco a las ${escapeHtml(formatTime(args.authorizedAt))}</p>`
    : '';
  const css = `<style>
.ok{width:6rem;height:6rem;border-radius:50%;background:#d4ff3a;display:grid;place-items:center}
.ok svg{width:3.2rem;height:3.2rem;stroke:#0b0b0b;stroke-width:3;fill:none}
.amount{font-size:3.4rem;font-weight:800;letter-spacing:-.03em;color:#f5f5f0;line-height:1}
.code{margin-top:.5rem;border:2px solid #2a2a2a;border-radius:10px;padding:.75rem 1rem;width:100%}
.code b{display:block;font-size:2.4rem;letter-spacing:.3em;color:#d4ff3a}
.clock{font-variant-numeric:tabular-nums;font-size:1.4rem;font-weight:700;color:#f5f5f0}
</style>`;
  const body = `
<div class="ok" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
<h1>Pagado</h1>
<div class="amount">${escapeHtml(formatAmount(args.amountCents, args.currency))}</div>
${confirmedAt}
<div class="code"><p>Código de confirmación</p><b>${escapeHtml(args.code)}</b><p>Debe coincidir con el que ve el personal</p></div>
<div class="clock" id="clock" aria-label="Hora actual"></div>
<script>
(function(){var el=document.getElementById('clock');function t(){el.textContent=new Date().toLocaleTimeString('es-ES',{timeZone:'Europe/Madrid'});}t();setInterval(t,1000);})();
</script>`;
  return page('Pagado', body, css);
}

function renderProcessingPage(refreshSeconds: number, offerNewCharge = false): string {
  const head = `<meta http-equiv="refresh" content="${refreshSeconds}"><style>
.spin{width:3rem;height:3rem;border:4px solid #2a2a2a;border-top-color:#d4ff3a;border-radius:50%;animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
</style>`;
  const body = `
<div class="spin" aria-hidden="true"></div>
<h1>Comprobando el pago</h1>
<p>Estamos esperando la confirmación del banco. No vuelvas a pagar: esta pantalla se actualiza sola.</p>
${offerNewCharge ? '<p>Si cerraste la página del banco sin pagar, pide un cobro nuevo al personal.</p>' : ''}`;
  return page('Comprobando el pago', body, head);
}

function renderMessagePage(
  title: string,
  message: string,
  tone: 'warn' | 'error' | 'neutral',
  action?: { href: string; label: string },
): string {
  const color = tone === 'error' ? '#ff5a5f' : tone === 'warn' ? '#ffb020' : '#b4b4ac';
  const body = `
<div style="width:4rem;height:4rem;border-radius:50%;border:3px solid ${color};display:grid;place-items:center" aria-hidden="true">
<svg viewBox="0 0 24 24" style="width:2rem;height:2rem;stroke:${color};stroke-width:2.5;fill:none;stroke-linecap:round;stroke-linejoin:round"><path d="M12 8v5M12 17h.01"/></svg>
</div>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
${action ? `<a class="btn" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>` : ''}`;
  return page(title, body);
}

/**
 * Renderiza HTML con un <form> oculto que auto-submitea al checkout del PSP.
 *
 * Diseño:
 *  - Auto-submit vía <script> al cargar la página (UX directa: parece un redirect).
 *  - Fallback con botón visible por si el navegador bloquea el auto-submit
 *    (iOS Safari ocasionalmente lo hace por seguridad).
 *  - <noscript> con botón también para usuarios sin JS.
 */
function renderCheckoutForm(action: string, fields: Record<string, string>): string {
  const inputs = Object.entries(fields)
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`,
    )
    .join('\n');

  const head = `<style>
.spin{width:2.5rem;height:2.5rem;border:4px solid #2a2a2a;border-top-color:#d4ff3a;border-radius:50%;animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
button{width:100%;margin-top:1rem;padding:1rem;border:none;border-radius:10px;background:#d4ff3a;color:#0b0b0b;font-weight:800;font-size:1.05rem;cursor:pointer}
</style>`;
  const body = `
<div class="spin" aria-hidden="true"></div>
<h1>Abriendo el pago…</h1>
<p>Si no avanza en 2 segundos, pulsa el botón.</p>
<form id="f" action="${escapeHtml(action)}" method="POST" accept-charset="UTF-8" style="width:100%">
${inputs}
<button type="submit">Continuar al pago</button>
</form>
<script>setTimeout(function(){document.getElementById('f').submit();},250);</script>`;
  return page('Abriendo el pago', body, head);
}
