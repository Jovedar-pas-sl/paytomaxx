import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Guard para endpoints /v1/debug/*.
 *
 * Política:
 *   - NODE_ENV !== 'production'  → siempre permite (developer trabajando local)
 *   - NODE_ENV === 'production'  → solo permite si DEBUG_ENDPOINTS_ENABLED=true
 *
 * Razón: los endpoints debug exponen estado interno (config metadata, payment
 * records, webhook raw bodies). En producción deben estar cerrados por defecto.
 * El operador flipa DEBUG_ENDPOINTS_ENABLED=true en Dokploy cuando necesita
 * diagnosticar, y back a false cuando termina.
 *
 * Logueamos cada bloqueo para detectar scans hostiles.
 */
@Injectable()
export class DebugEndpointsGuard implements CanActivate {
  private readonly logger = new Logger(DebugEndpointsGuard.name);
  private readonly config: ConfigService;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.config = config;
  }

  canActivate(ctx: ExecutionContext): boolean {
    const nodeEnv = this.config.get<string>('NODE_ENV');
    if (nodeEnv !== 'production') return true;

    const enabled = this.config.get<boolean>('DEBUG_ENDPOINTS_ENABLED');
    if (enabled === true) return true;

    const req = ctx.switchToHttp().getRequest<{
      url?: string;
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
    }>();
    const ip = req.headers?.['x-forwarded-for'] ?? req.ip ?? 'unknown';
    const url = req.url ?? '(unknown)';
    this.logger.warn(`Debug endpoint blocked: ${url} from ip=${String(ip)}`);

    throw new ForbiddenException(
      'Debug endpoints are disabled in production. Set DEBUG_ENDPOINTS_ENABLED=true in env to enable temporarily.',
    );
  }
}
