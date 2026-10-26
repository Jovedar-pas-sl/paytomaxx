import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ClsService } from 'nestjs-cls';
import type { JwtPayload } from '@nightpay/contracts';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { bindTenantContext, type RequestContext } from '../context/request-context';
import { AccessRevocationService } from '../../modules/auth/access-revocation.service';
import { bearerToken, verifyStaffToken } from './staff-token';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);
  private readonly jwt: JwtService;
  private readonly reflector: Reflector;
  private readonly cls: ClsService<{ ctx: RequestContext }>;
  private readonly revocations: AccessRevocationService;

  constructor(
    @Inject(JwtService) jwt: JwtService,
    @Inject(Reflector) reflector: Reflector,
    @Inject(ClsService) cls: ClsService<{ ctx: RequestContext }>,
    @Inject(AccessRevocationService) revocations: AccessRevocationService,
  ) {
    this.jwt = jwt;
    this.reflector = reflector;
    this.cls = cls;
    this.revocations = revocations;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      user?: JwtPayload;
    }>();

    const token = bearerToken(req.headers['authorization']);
    if (!token) throw new UnauthorizedException('Missing bearer token');

    const result = await verifyStaffToken(this.jwt, token);
    if (!result.ok) {
      this.logger.debug(`JWT rechazado: ${result.reason}`);
      throw new UnauthorizedException(result.reason === 'invalid' ? 'Invalid token' : 'Malformed token');
    }
    // La firma y la hora no bastan: si su sesión se cerró (logout, revocada,
    // baja, contraseña nueva) → 401 al momento. Sin Redis → 503 (fail-closed,
    // ver AccessRevocationService): no se cierra la sesión, se reintenta.
    await this.revocations.assertActive(result.payload);

    req.user = result.payload;
    // Local en el contexto para el middleware de Prisma. Sin contexto CLS
    // (p. ej. una ruta que se salte el middleware de CLS) se rechaza: antes
    // seguía SIN filtro por local (fail-open).
    bindTenantContext(this.cls, {
      tenantId: result.payload.tenantId,
      userId: result.payload.sub,
      role: result.payload.role,
      venueSlug: result.payload.venueSlug,
    });

    return true;
  }
}
