import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  STAFF_PERMISSION_DENIED_CODE,
  STAFF_PERMISSION_DENIED_MESSAGES,
  staffCan,
  staffPermissionsOf,
  type JwtPayload,
  type StaffPermissionKey,
} from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Permisos del personal (Ajustes → Permisos): encima de @Roles, el dueño
 * quita (o, los informes, da) acciones al encargado. El permiso se mira en
 * la base en cada petición: un cambio vale al momento, sin volver a entrar.
 */

export const STAFF_PERMISSION_KEY = 'staffPermission';

/** Qué permiso pide la ruta; puede depender del cuerpo (p. ej. efectivo o tarjeta). */
export type PermissionRequirement = StaffPermissionKey | ((req: { body?: unknown }) => StaffPermissionKey);

export const RequiresPermission = (requirement: PermissionRequirement): MethodDecorator =>
  SetMetadata(STAFF_PERMISSION_KEY, requirement);

export function permissionDenied(key: StaffPermissionKey): ForbiddenException {
  return new ForbiddenException({ message: STAFF_PERMISSION_DENIED_MESSAGES[key], code: STAFF_PERMISSION_DENIED_CODE, permission: key });
}

type GuardRequest = { user?: JwtPayload; body?: unknown };

@Injectable()
export class StaffPermissionGuard implements CanActivate {
  private readonly reflector: Reflector;
  private readonly prisma: PrismaService;

  constructor(@Inject(Reflector) reflector: Reflector, @Inject(PrismaService) prisma: PrismaService) {
    this.reflector = reflector;
    this.prisma = prisma;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.get<PermissionRequirement | undefined>(STAFF_PERMISSION_KEY, ctx.getHandler());
    if (!requirement) return true;
    const req = ctx.switchToHttp().getRequest<GuardRequest>();
    const user = req.user;
    if (!user) throw new ForbiddenException('Authentication required');
    if (user.role === 'OWNER') return true;
    const key = typeof requirement === 'function' ? requirement(req) : requirement;
    // Venue no va por local en el middleware: id explícito del JWT.
    const venue = await this.prisma.asSystem((tx) =>
      tx.venue.findUnique({ where: { id: user.tenantId }, select: { staffPermissions: true } }),
    );
    if (!staffCan(staffPermissionsOf(venue?.staffPermissions), { role: user.role, userId: user.sub }, key)) {
      throw permissionDenied(key);
    }
    return true;
  }
}
