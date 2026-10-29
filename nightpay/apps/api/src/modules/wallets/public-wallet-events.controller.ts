import type { OutgoingHttpHeaders } from 'node:http';
import { Controller, Get, Headers, HttpException, HttpStatus, Inject, Param, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { IpRateLimit } from '../../common/guards/ip-rate-limit.guard';
import { clientIp, rateLimitIpKey } from '../../common/http/client-ip';
import { STREAM_MAX_LIFETIME_MS, WalletStreamHub } from '../wallet-events/wallet-stream.hub';
import { WalletChargesService } from './wallet-charges.service';
import { WalletPasskeysService } from './wallet-passkeys.service';
import { walletStreamAccess } from './wallet-view-access';

/**
 * GET /w/:token/events — «saldo al momento» (H-1): la página del saldo deja
 * abierta esta conexión (text/event-stream) y, cuando su saldo cambia (un
 * cobro, una recarga, una devolución…), recibe «cambió» y vuelve a pedir
 * /w/:token/state. Antes preguntaba cada 3 s; ahora solo cuando hay algo, y
 * cada 20–30 s de respaldo.
 *
 *  - La misma protección que /state: el enlace y, si el saldo tiene Face ID,
 *    su sesión de consulta (401 WALLET_VIEW_REQUIRED si no). Abrirla es
 *    actividad: alarga la sesión (Set-Cookie) como una lectura.
 *  - Se cierra sola cuando caduca esa sesión o, como mucho, a los ~10 min
 *    (STREAM_MAX_LIFETIME_MS, con algo de azar): la página vuelve a entrar y
 *    se vuelve a mirar su acceso.
 *  - Latido cada 20 s y X-Accel-Buffering: no (Cloudflare corta a los 100 s
 *    sin bytes; un proxy con búfer retendría los avisos).
 *  - Topes por réplica: por saldo y por IP (WalletStreamHub); pasado el de la
 *    IP, 429 WALLET_EVENTS_BUSY y la página sigue con el sondeo de respaldo.
 *  - Por aquí no va ningún dato del saldo: solo el aviso y la hora.
 */
@Controller('w')
export class PublicWalletEventsController {
  constructor(
    @Inject(WalletChargesService) private readonly charges: WalletChargesService,
    @Inject(WalletPasskeysService) private readonly passkeys: WalletPasskeysService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(WalletStreamHub) private readonly hub: WalletStreamHub,
  ) {}

  @Public()
  @Get(':token/events')
  @IpRateLimit({ max: 120, windowSec: 60, scope: 'wallet-events', failOpen: true })
  async events(
    @Param('token') token: string,
    @Headers('cookie') cookies: string | undefined,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const access = await walletStreamAccess(
      {
        walletRefByToken: (value) => this.charges.walletRefByToken(value),
        hasPasskey: (id) => this.passkeys.hasPasskey(id),
        secret: this.config.get<string>('COOKIE_SECRET') ?? '',
      },
      token,
      cookies,
    );
    if (!access.allowed) throw new UnauthorizedException({ message: 'Desbloquea tu saldo con tu teléfono.', code: 'WALLET_VIEW_REQUIRED' });
    const ip = rateLimitIpKey(clientIp(req) ?? 'desconocida');
    if (!this.hub.canOpen(ip)) {
      throw new HttpException(
        { message: 'Hay muchas páginas abiertas desde esta red: tu saldo se pone al día solo cada pocos segundos.', code: 'WALLET_EVENTS_BUSY' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const now = Date.now();
    // Con azar: las páginas de un local no vuelven a entrar todas a la vez.
    const lifetime = Math.round(STREAM_MAX_LIFETIME_MS * (0.8 + Math.random() * 0.2));
    const closeAt = Math.min(now + lifetime, access.expiresAt === null ? Number.POSITIVE_INFINITY : access.expiresAt * 1000);

    res.hijack();
    const raw = res.raw;
    raw.writeHead(200, streamHeaders(res.getHeaders(), access.renew));
    const opened = this.hub.open(
      {
        walletId: access.walletId,
        ip,
        closeAt,
        sink: { write: (chunk) => raw.write(chunk), end: () => raw.end() },
      },
      now,
    );
    if (!opened.ok) {
      // La réplica se está apagando: que vuelva (a la nueva).
      raw.end('event: bye\ndata: {"r":"restart"}\n\n');
      return;
    }
    req.raw.on('close', () => this.hub.close(opened.stream));
  }
}

/** Las de seguridad de siempre (helmet) y las del flujo de eventos. */
function streamHeaders(base: Record<string, unknown>, renew: string[] | null): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(base)) {
    if (name === 'content-type' || name === 'content-length') continue;
    if (typeof value === 'string' || typeof value === 'number' || Array.isArray(value)) headers[name] = value as OutgoingHttpHeaders[string];
  }
  return {
    ...headers,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    'x-accel-buffering': 'no',
    'referrer-policy': 'no-referrer',
    connection: 'keep-alive',
    ...(renew ? { 'set-cookie': renew } : {}),
  };
}
