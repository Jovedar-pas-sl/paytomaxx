import {
  createParamDecorator,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { RequestContext } from '../../common/context/request-context';
import { PrismaService } from '../../common/prisma/prisma.service';
import { sha256 } from './paytef';

/** Datáfono vinculado que hace la petición. */
export interface PosDevice {
  terminalId: string;
  tenantId: string;
  label: string;
  zone: string | null;
}

/** "Visto por última vez" se apunta como mucho una vez por minuto. */
const LAST_SEEN_EVERY_MS = 60_000;

/**
 * Autenticación del datáfono: `Authorization: Device <credencial>`. Va con
 * @Public() (no hay usuario): la credencial identifica el terminal y su local.
 */
@Injectable()
export class DeviceGuard implements CanActivate {
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
      posDevice?: PosDevice;
    }>();
    const header = req.headers['authorization'];
    const token = typeof header === 'string' && header.startsWith('Device ') ? header.slice(7).trim() : '';
    if (!token) throw new UnauthorizedException('Datáfono sin vincular');

    const terminal = await this.prisma.asSystem((tx) =>
      tx.terminal.findFirst({
        where: { deviceTokenHash: sha256(token), active: true },
        select: { id: true, tenantId: true, label: true, zone: true, deviceLastSeenAt: true },
      }),
    );
    if (!terminal) throw new UnauthorizedException('Datáfono sin vincular');

    req.posDevice = { terminalId: terminal.id, tenantId: terminal.tenantId, label: terminal.label, zone: terminal.zone };
    // Contexto del local para el middleware de Prisma (como hace AuthGuard).
    if (this.cls.isActive()) {
      this.cls.set('ctx', { ...(this.cls.get('ctx') ?? {}), tenantId: terminal.tenantId });
    }
    if (!terminal.deviceLastSeenAt || Date.now() - terminal.deviceLastSeenAt.getTime() > LAST_SEEN_EVERY_MS) {
      await this.prisma.asSystem((tx) =>
        tx.terminal.update({ where: { id: terminal.id }, data: { deviceLastSeenAt: new Date() } }),
      );
    }
    return true;
  }
}

export const CurrentDevice = createParamDecorator((_data: unknown, ctx: ExecutionContext): PosDevice => {
  const device = ctx.switchToHttp().getRequest<{ posDevice?: PosDevice }>().posDevice;
  if (!device) throw new UnauthorizedException('Datáfono sin vincular');
  return device;
});
