import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

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
  private readonly prisma: PrismaService;

  constructor(@Inject(ConfigService) config: ConfigService, @Inject(PrismaService) prisma: PrismaService) {
    this.config = config;
    this.prisma = prisma;
  }

  /**
   * Fuera de producción, con sesión basta. En producción hacen falta las dos
   * cosas: el interruptor DEBUG_ENDPOINTS_ENABLED y una sesión de superadmin
   * (estos endpoints enseñan datos de todos los locales).
   */
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const nodeEnv = this.config.get<string>('NODE_ENV');
    if (nodeEnv !== 'production') return true;
    const userId = ctx.switchToHttp().getRequest<{ user?: { sub?: string } }>().user?.sub;
    const admin = userId
      ? await this.prisma.asSystem((tx) =>
          tx.user.findUnique({ where: { id: userId }, select: { isSuperAdmin: true, deletedAt: true } }),
        )
      : null;
    if (!admin || admin.deletedAt || !admin.isSuperAdmin) {
      throw new ForbiddenException('Solo superadmin');
    }

    // ConfigModule.forRoot() lee process.env directo sin Zod parsing,
    // así que DEBUG_ENDPOINTS_ENABLED llega como string "true" no boolean.
    const raw = this.config.get<string | boolean | undefined>(
      'DEBUG_ENDPOINTS_ENABLED',
    );
    const enabled = raw === true || raw === 'true' || raw === '1';
    if (enabled) return true;

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
