import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { clientIp, type ClientIpRequest } from '../http/client-ip';

/**
 * Guard para GET /v1/metrics.
 *
 * Política:
 *   - NODE_ENV !== 'production' → siempre permite.
 *   - Producción → solo con `Authorization: Bearer <METRICS_TOKEN>`; si no,
 *     404 (no revelamos que existe). También el scrape interno: antes se
 *     dejaba pasar lo que llegaba "sin cabeceras de proxy", pero eso no prueba
 *     de dónde viene la petición (basta con no mandarlas). Sin METRICS_TOKEN
 *     configurado, las métricas quedan cerradas (aviso al arrancar).
 *
 * Razón: las métricas exponen ids de local y volumen de cobros.
 */
@Injectable()
export class MetricsAccessGuard implements CanActivate {
  private readonly logger = new Logger(MetricsAccessGuard.name);
  private readonly config: ConfigService;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.config = config;
  }

  canActivate(ctx: ExecutionContext): boolean {
    if (this.config.get<string>('NODE_ENV') !== 'production') return true;

    const req = ctx.switchToHttp().getRequest<ClientIpRequest>();
    const token = this.config.get<string>('METRICS_TOKEN') ?? '';
    const auth = req.headers.authorization;
    const presented = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token && presented && safeEqual(presented, token)) return true;

    this.logger.warn(`Metrics blocked from ip=${clientIp(req) ?? 'unknown'}`);
    throw new NotFoundException();
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
