import { Controller, Get, Inject, Logger, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { PaymentsService } from './payments.service';

/**
 * Endpoint público `/pay/:token` (FUERA del prefijo /v1) — el cliente
 * escanea el QR y llega aquí.
 *
 * Según el shape devuelto por `resolveRedirect()`:
 *  - `kind: 'redirect'` (Paytef) → HTTP 302 a la URL hosted del PSP
 *  - `kind: 'form'` (Cecabank/Wipay) → HTML con `<form>` auto-submit POST
 *
 * Cuando exista una web-client app dedicada en otro dominio, el QR puede
 * apuntar allí en su lugar; este controller queda como fallback cuando
 * NEXT_PUBLIC_WEB_CLIENT_URL no está configurado.
 *
 * `/pay/result` muestra una página estática "Pago correcto / fallido" tras
 * volver del PSP (Cecabank exige URL_OK + URL_NOK obligatorias).
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
  async paymentResult(
    @Query('status') status: string,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const ok = status === 'ok';
    res
      .status(200)
      .header('Content-Type', 'text/html; charset=utf-8')
      .send(renderPayResultPage(ok));
  }

  @Public()
  @Get(':token')
  async redirect(@Param('token') token: string, @Res() res: FastifyReply): Promise<void> {
    try {
      const result = await this.payments.resolveRedirect(token);
      if (result.kind === 'redirect') {
        // Paytef u otros PSPs con URL hosted → 302
        res.status(302).header('Location', result.url).send();
        return;
      }
      // result.kind === 'form' → render HTML con auto-submit
      res
        .status(200)
        .header('Content-Type', 'text/html; charset=utf-8')
        .send(renderCheckoutForm(result.action, result.fields));
    } catch (err) {
      const message = (err as Error).message || 'Error';
      // Logueamos detalles técnicos pero NO los mostramos al cliente
      this.logger.warn(`/pay/${token} redirect failed: ${message}`);
      const friendly = humanizePayError(message);
      res
        .status(409)
        .header('Content-Type', 'text/html; charset=utf-8')
        .send(renderPayErrorPage(friendly));
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

/**
 * Mapea mensajes técnicos de excepción a frases pensadas para cliente
 * borracho a las 3am. NO devolver detalles que confundan o filtren
 * estructura interna.
 */
function humanizePayError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('expired') || m.includes('expirado') || m.includes('caduca')) {
    return 'Este cobro ha caducado. Pide a la chica uno nuevo.';
  }
  if (m.includes('not found') || m.includes('no encontrado')) {
    return 'Este cobro ya no existe. Pide a la chica uno nuevo.';
  }
  if (m.includes('already') || m.includes('ya')) {
    return 'Este cobro ya se ha procesado o está en curso.';
  }
  if (m.includes('gateway') || m.includes('pasarela') || m.includes('redsys') || m.includes('sis')) {
    return 'Hay un problema con la pasarela de pago. Vuelve a intentarlo en unos segundos o pide a la chica un cobro nuevo.';
  }
  return 'No se ha podido continuar con el cobro. Pide a la chica un cobro nuevo.';
}

function renderPayResultPage(ok: boolean): string {
  const heading = ok ? '¡Pagado!' : 'No se ha cobrado';
  const subhead = ok
    ? 'Tu pago se ha realizado correctamente.'
    : 'Vuelve al local y pide a la chica que te genere un cobro nuevo.';
  const cta = ok ? 'Ya puedes cerrar esta pantalla.' : '';
  const accentColor = ok ? '#5af074' : '#ff7575';
  const accentBg = ok ? 'rgba(90,240,116,0.15)' : 'rgba(255,117,117,0.15)';
  const iconPath = ok
    ? '<path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/>'
    : '<path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" stroke-linejoin="round"/>';
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui;margin:0;padding:1.5rem;background:#0a0a0a;color:#fff;display:grid;place-items:center;min-height:100vh}
  main{max-width:22rem;text-align:center}
  .icon{width:6rem;height:6rem;margin:0 auto 1.25rem;border-radius:50%;background:${accentBg};border:3px solid ${accentColor};display:grid;place-items:center;animation:pop 0.4s cubic-bezier(0.34,1.56,0.64,1)}
  .icon svg{width:3rem;height:3rem;stroke:${accentColor};stroke-width:3;fill:none}
  h1{font-size:2rem;margin:0 0 0.75rem;color:${accentColor};font-weight:700}
  p{color:#ddd;line-height:1.5;font-size:1.05rem;margin:0 0 0.5rem}
  .hint{color:#888;font-size:0.95rem;margin-top:0.25rem}
  .footer{margin-top:2.5rem;font-size:0.75rem;color:#666;display:flex;align-items:center;justify-content:center;gap:0.375rem}
  @keyframes pop{0%{transform:scale(0);opacity:0}60%{transform:scale(1.1);opacity:1}100%{transform:scale(1);opacity:1}}
</style>
</head><body><main>
<div class="icon"><svg viewBox="0 0 24 24">${iconPath}</svg></div>
<h1>${heading}</h1>
<p>${subhead}</p>
${cta ? `<p class="hint">${cta}</p>` : ''}
<div class="footer">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>
  Pago seguro · NightPay
</div>
</main></body></html>`;
}

function renderPayErrorPage(friendly: string): string {
  const safeMessage = escapeHtml(friendly);
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cobro no disponible</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui;margin:0;padding:1.5rem;background:#0a0a0a;color:#fff;display:grid;place-items:center;min-height:100vh}
  main{max-width:22rem;text-align:center}
  .icon{width:4rem;height:4rem;margin:0 auto 1.5rem;border-radius:50%;background:rgba(255,117,117,0.15);border:2px solid #ff7575;display:grid;place-items:center}
  .icon svg{width:2rem;height:2rem;stroke:#ff7575;stroke-width:2.5;fill:none;stroke-linecap:round;stroke-linejoin:round}
  h1{font-size:1.25rem;margin:0 0 1rem;color:#fff;font-weight:600}
  p{color:#bbb;line-height:1.5;font-size:1.05rem;margin:0}
  .footer{margin-top:2rem;font-size:0.75rem;color:#666;display:flex;align-items:center;justify-content:center;gap:0.375rem}
</style>
</head><body><main>
<div class="icon"><svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M4.93 19h14.14a2 2 0 001.74-3L13.74 4a2 2 0 00-3.48 0L3.19 16a2 2 0 001.74 3z"/></svg></div>
<h1>Cobro no disponible</h1>
<p>${safeMessage}</p>
<div class="footer">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>
  Pago seguro · NightPay
</div>
</main></body></html>`;
}

/**
 * Renderiza HTML con un <form> oculto que auto-submitea al checkout del PSP.
 *
 * Diseño:
 *  - Auto-submit vía <script> al cargar la página (UX directa: parece un redirect).
 *  - Fallback con botón visible "Pagar ahora" por si el navegador bloquea
 *    auto-submit (iOS Safari ocasionalmente lo hace por seguridad).
 *  - <noscript> con botón también para usuarios sin JS.
 */
function renderCheckoutForm(action: string, fields: Record<string, string>): string {
  const inputs = Object.entries(fields)
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Continuando al pago…</title>
<style>
  body{font-family:system-ui;margin:0;padding:2rem;background:#0a0a0a;color:#fff;display:grid;place-items:center;min-height:100vh}
  main{max-width:22rem;text-align:center}
  .spinner{width:2rem;height:2rem;margin:0 auto 1rem;border:3px solid #333;border-top-color:#5af074;border-radius:50%;animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{font-size:1.1rem;margin:0 0 0.5rem;color:#eee}
  p{color:#888;font-size:0.85rem;line-height:1.5;margin:0 0 1.5rem}
  button{background:#5af074;color:#000;border:none;padding:0.85rem 1.5rem;border-radius:0.5rem;font-size:1rem;font-weight:600;cursor:pointer;width:100%}
  button:hover{filter:brightness(1.1)}
</style>
</head><body><main>
<div class="spinner" id="sp"></div>
<h1>Conectando con la pasarela de pago…</h1>
<p>Si esta página no avanza en 2 segundos, pulsa el botón.</p>
<form id="f" action="${escapeHtml(action)}" method="POST" accept-charset="UTF-8">
${inputs}
<button type="submit">Continuar al pago</button>
</form>
<noscript><p style="margin-top:1rem;color:#bbb">Activa JavaScript o pulsa el botón "Continuar al pago".</p></noscript>
<script>
  // Auto-submit tras carga. Pequeño delay para que el spinner sea visible.
  setTimeout(function(){ document.getElementById('f').submit(); }, 250);
</script>
</main></body></html>`;
}
