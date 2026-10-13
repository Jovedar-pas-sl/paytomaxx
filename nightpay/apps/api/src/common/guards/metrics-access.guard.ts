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

/**
 * Guard para GET /v1/metrics.
 *
 * Política:
 *   - NODE_ENV !== 'production' → siempre permite.
 *   - Producción, petición SIN cabeceras de proxy → permite. Es el scrape
 *     interno (Grafana agent contra `nightpay-api:4100` en la red Docker);
 *     el puerto 4100 no está publicado, así que desde fuera solo se llega
 *     pasando por Cloudflare + Traefik, que siempre añaden estas cabeceras.
 *   - Producción, petición desde internet → solo con
 *     `Authorization: Bearer <METRICS_TOKEN>`; si no, 404 (no revelamos que existe).
 *
 * Razón: las métricas exponen ids de local y volumen de cobros.
 */
const PROXY_HEADERS = ['cf-ray', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip'];

@Injectable()
export class MetricsAccessGuard implements CanActivate {
  private readonly logger = new Logger(MetricsAccessGuard.name);
  private readonly config: ConfigService;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.config = config;
  }

  canActivate(ctx: ExecutionContext): boolean {
    if (this.config.get<string>('NODE_ENV') !== 'production') return true;

    const req = ctx.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
    }>();
    const headers = req.headers ?? {};
    const viaProxy = PROXY_HEADERS.some((h) => headers[h] !== undefined);
    if (!viaProxy) return true;

    const token = this.config.get<string>('METRICS_TOKEN') ?? '';
    const auth = headers.authorization;
    const presented = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token && presented && safeEqual(presented, token)) return true;

    this.logger.warn(`Metrics blocked from ip=${String(headers['cf-connecting-ip'] ?? headers['x-forwarded-for'] ?? 'unknown')}`);
    throw new NotFoundException();
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
