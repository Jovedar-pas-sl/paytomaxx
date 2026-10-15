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
import { clientIp, type ClientIpRequest } from '../http/client-ip';

type DebugRequest = ClientIpRequest & { url?: string; user?: { sub?: string } };

/**
 * Guard para endpoints /v1/debug/*.
 *
 * Política (en TODOS los entornos): hace falta el interruptor
 * DEBUG_ENDPOINTS_ENABLED=true Y una sesión de superadmin. Antes, fuera de
 * producción bastaba con cualquier sesión, y con NODE_ENV mal puesto eso
 * dejaba datos de todos los locales a cualquier camarero.
 *
 * Razón: los endpoints debug consultan pagos y avisos de todos los locales.
 * El dueño activa DEBUG_ENDPOINTS_ENABLED en Dokploy para diagnosticar y lo
 * vuelve a poner a false al terminar (aviso al arrancar mientras esté abierto).
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

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<DebugRequest>();
    if (!this.enabled()) {
      this.logBlocked(req, 'interruptor apagado');
      throw new ForbiddenException('Endpoints de debug desactivados (DEBUG_ENDPOINTS_ENABLED).');
    }
    if (!(await this.isSuperAdmin(req.user?.sub))) {
      this.logBlocked(req, 'no es superadmin');
      throw new ForbiddenException('Solo superadmin');
    }
    return true;
  }

  /** ConfigService ya devuelve el booleano validado; se acepta también el texto. */
  private enabled(): boolean {
    const raw = this.config.get<string | boolean | undefined>('DEBUG_ENDPOINTS_ENABLED');
    return raw === true || raw === 'true' || raw === '1';
  }

  private async isSuperAdmin(userId: string | undefined): Promise<boolean> {
    if (!userId) return false;
    // Sin el filtro por local: el super-admin puede estar viendo otro local.
    const user = await this.prisma.acrossVenues((tx) =>
      tx.user.findUnique({ where: { id: userId }, select: { isSuperAdmin: true, deletedAt: true } }),
    );
    return Boolean(user && !user.deletedAt && user.isSuperAdmin);
  }

  private logBlocked(req: DebugRequest, reason: string): void {
    this.logger.warn(`Debug endpoint bloqueado (${reason}): ${req.url ?? '(desconocida)'} ip=${clientIp(req) ?? 'unknown'}`);
  }
}
