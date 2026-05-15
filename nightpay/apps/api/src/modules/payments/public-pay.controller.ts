import { Controller, Get, Inject, Logger, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { PaymentsService } from './payments.service';

/**
 * Endpoint público `/pay/:token` (FUERA del prefijo /v1) — el cliente
 * escanea el QR y llega aquí. Resolvemos el checkout del PSP y devolvemos
 * 302. Si todavía no se ha iniciado authorize, lo lanzamos ahora.
 *
 * Cuando exista una web-client app dedicada en otro dominio, el QR puede
 * apuntar allí en su lugar; este controller queda como fallback cuando
 * NEXT_PUBLIC_WEB_CLIENT_URL no está configurado.
 */
@Controller('pay')
export class PublicPayController {
  private readonly logger = new Logger(PublicPayController.name);
  private readonly payments: PaymentsService;

  constructor(@Inject(PaymentsService) payments: PaymentsService) {
    this.payments = payments;
  }

  @Public()
  @Get(':token')
  async redirect(@Param('token') token: string, @Res() res: FastifyReply): Promise<void> {
    try {
      const { url } = await this.payments.resolveRedirect(token);
      // 302 Found — el navegador del cliente va al checkout Paytef.
      res.status(302).header('Location', url).send();
    } catch (err) {
      const message = (err as Error).message || 'Error';
      this.logger.warn(`/pay/${token} redirect failed: ${message}`);
      // HTML mínimo (móvil renderizable, sin assets externos).
      const escaped = message.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
      );
      res
        .status(409)
        .header('Content-Type', 'text/html; charset=utf-8')
        .send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cobro no disponible</title>
<style>body{font-family:system-ui;margin:0;padding:2rem;background:#0a0a0a;color:#fff;display:grid;place-items:center;min-height:100vh}main{max-width:24rem;text-align:center}h1{font-size:1.25rem;margin:0 0 1rem}p{color:#bbb;line-height:1.5}</style>
</head><body><main><h1>No se puede continuar con el cobro</h1><p>${escaped}</p><p style="margin-top:2rem;font-size:0.8rem;color:#666">Pide a quien te lo envió que genere un nuevo cobro.</p></main></body></html>`);
    }
  }
}
