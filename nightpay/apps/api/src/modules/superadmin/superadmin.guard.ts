import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import type { JwtPayload } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { clientIp, type ClientIpRequest } from '../../common/http/client-ip';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { totpForbidden } from '../auth/totp-code';

/** Quién usa la consola: comprobado en la base en esta misma petición. */
export interface SuperAdminActor {
  readonly id: string;
  readonly email: string;
  readonly ip?: string;
  readonly userAgent?: string;
}

export const SUPERADMIN_FORBIDDEN = 'Solo para super-admins';

type GuardRequest = ClientIpRequest & { user?: JwtPayload; superAdmin?: SuperAdminActor };

/**
 * /v1/superadmin/*: sesión (el AuthGuard global ya verificó el JWT) y además
 * users.isSuperAdmin leído AHORA de la base, con el usuario sin dar de baja.
 * La family del JWT debe seguir viva, pertenecer a ese usuario y haber
 * probado la 2FA; además, la 2FA debe seguir activada en la base.
 * Un JWT anterior a la promoción o a una revocación no basta. Se busca con
 * acrossVenues: el super-admin puede tener otro local activo en su sesión.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  private readonly prisma: PrismaService;
  private readonly sessions: RefreshTokenService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(RefreshTokenService) sessions: RefreshTokenService,
  ) {
    this.prisma = prisma;
    this.sessions = sessions;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<GuardRequest>();
    const sub = req.user?.sub;
    if (!sub) throw new UnauthorizedException('Falta la sesión');
    const user = await this.prisma.acrossVenues((tx) =>
      tx.user.findUnique({
        where: { id: sub },
        select: { id: true, email: true, isSuperAdmin: true, deletedAt: true, totpSecret: true },
      }),
    );
    if (!user || user.deletedAt || !user.isSuperAdmin) throw new ForbiddenException(SUPERADMIN_FORBIDDEN);
    const sid = req.user?.sid;
    const session = sid ? await this.sessions.liveSession(sid) : null;
    if (!sid || !session || session.userId !== user.id) throw new UnauthorizedException('Sesión caducada: vuelve a iniciar sesión');
    if (!user.totpSecret) throw totpForbidden('notEnrolled');
    if (!(await this.sessions.hasTwoFactor(sid))) throw totpForbidden('required');
    const ua = req.headers['user-agent'];
    req.superAdmin = {
      id: user.id,
      email: user.email,
      ip: clientIp(req) ?? undefined,
      userAgent: typeof ua === 'string' ? ua.slice(0, 300) : undefined,
    };
    return true;
  }
}

/** El super-admin que dejó SuperAdminGuard en la petición. */
export const CurrentSuperAdmin = createParamDecorator((_data: unknown, ctx: ExecutionContext): SuperAdminActor => {
  const actor = ctx.switchToHttp().getRequest<GuardRequest>().superAdmin;
  if (!actor) throw new ForbiddenException(SUPERADMIN_FORBIDDEN);
  return actor;
});
