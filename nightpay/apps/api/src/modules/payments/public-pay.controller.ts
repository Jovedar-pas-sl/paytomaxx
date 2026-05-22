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
      .send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? 'Pago correcto' : 'Pago no completado'}</title>
<style>
  body{font-family:system-ui;margin:0;padding:2rem;background:${ok ? '#0a1a0a' : '#1a0a0a'};color:#fff;display:grid;place-items:center;min-height:100vh}
  main{max-width:24rem;text-align:center}
  .icon{font-size:4rem;margin-bottom:1rem}
  h1{font-size:1.5rem;margin:0 0 0.75rem;color:${ok ? '#5af074' : '#ff7575'}}
  p{color:#bbb;line-height:1.5;font-size:0.95rem}
</style>
</head><body><main>
<div class="icon">${ok ? '✓' : '✕'}</div>
<h1>${ok ? '¡Gracias por tu pago!' : 'No se ha completado el pago'}</h1>
<p>${ok ? 'La operación se ha registrado correctamente. Puedes cerrar esta ventana.' : 'Vuelve al local y pide a quien te lo envió que genere un nuevo cobro.'}</p>
</main></body></html>`);
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
      this.logger.warn(`/pay/${token} redirect failed: ${message}`);
      const escaped = escapeHtml(message);
      res
        .status(409)
        .header('Content-Type', 'text/html; charset=utf-8')
        .send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cobro no disponible</title>
<style>
  body{font-family:system-ui;margin:0;padding:1rem;background:#0a0a0a;color:#fff;min-height:100vh}
  main{max-width:50rem;margin:0 auto}
  h1{font-size:1.1rem;margin:0 0 0.75rem}
  pre{background:#1a1a1a;color:#eee;padding:1rem;border-radius:0.5rem;font-size:0.7rem;line-height:1.4;white-space:pre-wrap;word-break:break-all;max-height:60vh;overflow:auto;user-select:all;-webkit-user-select:all}
  .hint{margin-top:1rem;font-size:0.75rem;color:#666}
  button{margin-top:0.5rem;padding:0.5rem 1rem;background:#333;color:#fff;border:1px solid #555;border-radius:0.3rem;font-size:0.85rem;cursor:pointer}
</style>
</head><body><main>
<h1>No se puede continuar con el cobro</h1>
<pre id="m">${escaped}</pre>
<button onclick="navigator.clipboard.writeText(document.getElementById('m').textContent).then(()=>this.textContent='✓ Copiado')">Copiar todo</button>
<p class="hint">Pide a quien te lo envió que genere un nuevo cobro.</p>
</main></body></html>`);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
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
