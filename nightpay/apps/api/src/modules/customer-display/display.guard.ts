import {
  createParamDecorator,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { bindTenantContext, type RequestContext } from '../../common/context/request-context';
import { PrismaService } from '../../common/prisma/prisma.service';
import { displayTokenFromHeader, findActiveDisplay, type DisplaySession } from './display-auth';

/** 401 de la tablet: vuelve a la pantalla de emparejar. */
export const DISPLAY_NOT_PAIRED = 'Pantalla sin emparejar: pide un código nuevo en la app del personal.';

/** «Visto por última vez» se apunta como mucho una vez por minuto. */
const LAST_SEEN_EVERY_MS = 60_000;

/**
 * La «Pantalla del cliente»: `Authorization: Pantalla <credencial>`. Va con
 * @Public() (no hay usuario). Solo la llevan las rutas de la tablet (leer el
 * cobro activo y desemparejarse); la credencial no es un JWT, así que el
 * AuthGuard del personal la rechaza en cualquier otra ruta.
 */
@Injectable()
export class DisplayGuard implements CanActivate {
  private readonly prisma: PrismaService;
  private readonly cls: ClsService<{ ctx: RequestContext }>;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(ClsService) cls: ClsService<{ ctx: RequestContext }>,
  ) {
    this.prisma = prisma;
    this.cls = cls;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      customerDisplay?: DisplaySession;
    }>();
    const token = displayTokenFromHeader(req.headers['authorization']);
    if (!token) throw new UnauthorizedException(DISPLAY_NOT_PAIRED);
    const display = await findActiveDisplay(this.prisma, token);
    if (!display) throw new UnauthorizedException(DISPLAY_NOT_PAIRED);
    req.customerDisplay = display;
    // Contexto del local para el middleware de Prisma (como el datáfono).
    bindTenantContext(this.cls, { tenantId: display.tenantId });
    if (!display.lastSeenAt || Date.now() - display.lastSeenAt.getTime() > LAST_SEEN_EVERY_MS) {
      await this.prisma.asSystem((tx) =>
        tx.customerDisplay.update({ where: { id: display.id }, data: { lastSeenAt: new Date() } }),
      );
    }
    return true;
  }
}

export const CurrentDisplay = createParamDecorator((_data: unknown, ctx: ExecutionContext): DisplaySession => {
  const display = ctx.switchToHttp().getRequest<{ customerDisplay?: DisplaySession }>().customerDisplay;
  if (!display) throw new UnauthorizedException(DISPLAY_NOT_PAIRED);
  return display;
});
