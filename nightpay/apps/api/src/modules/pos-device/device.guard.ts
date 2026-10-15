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
import { deviceTokenExpired, deviceTokenMaxAgeMs, sha256 } from './paytef';

/** Datáfono vinculado que hace la petición. */
export interface PosDevice {
  terminalId: string;
  tenantId: string;
  label: string;
  zone: string | null;
  /** Hash de la credencial con la que llamó (para rotarla). */
  tokenHash: string;
}

/** "Visto por última vez" se apunta como mucho una vez por minuto. */
const LAST_SEEN_EVERY_MS = 60_000;

const NOT_PAIRED = 'Datáfono sin vincular';
const EXPIRED = 'La credencial del datáfono ha caducado: vuelve a vincularlo desde el panel';

/**
 * Autenticación del datáfono: `Authorization: Device <credencial>`. Va con
 * @Public() (no hay usuario): la credencial identifica el terminal y su local.
 *
 * Vale la credencial en uso o la nueva de una rotación (POST /rotate); la
 * primera vez que llega la nueva, pasa a ser la única. Con
 * POS_DEVICE_TOKEN_MAX_AGE_DAYS, una credencial más vieja que eso ya no vale
 * (sin la variable no caduca: es lo de por defecto).
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
    if (!token) throw new UnauthorizedException(NOT_PAIRED);

    const tokenHash = sha256(token);
    const terminal = await this.prisma.asSystem((tx) =>
      tx.terminal.findFirst({
        where: { active: true, OR: [{ deviceTokenHash: tokenHash }, { deviceTokenNextHash: tokenHash }] },
        select: {
          id: true,
          tenantId: true,
          label: true,
          zone: true,
          deviceLastSeenAt: true,
          deviceTokenHash: true,
          deviceTokenIssuedAt: true,
          devicePairedAt: true,
        },
      }),
    );
    if (!terminal) throw new UnauthorizedException(NOT_PAIRED);

    const issuedAt = terminal.deviceTokenIssuedAt ?? terminal.devicePairedAt;
    if (deviceTokenExpired(issuedAt, new Date(), deviceTokenMaxAgeMs(process.env.POS_DEVICE_TOKEN_MAX_AGE_DAYS))) {
      throw new UnauthorizedException(EXPIRED);
    }
    if (terminal.deviceTokenHash !== tokenHash) await this.promoteNextToken(terminal.id, tokenHash);

    req.posDevice = {
      terminalId: terminal.id,
      tenantId: terminal.tenantId,
      label: terminal.label,
      zone: terminal.zone,
      tokenHash,
    };
    // Contexto del local para el middleware de Prisma (como hace AuthGuard):
    // sin contexto CLS se corta, en vez de seguir sin filtro por local.
    bindTenantContext(this.cls, { tenantId: terminal.tenantId });
    if (!terminal.deviceLastSeenAt || Date.now() - terminal.deviceLastSeenAt.getTime() > LAST_SEEN_EVERY_MS) {
      await this.prisma.asSystem((tx) =>
        tx.terminal.update({ where: { id: terminal.id }, data: { deviceLastSeenAt: new Date() } }),
      );
    }
    return true;
  }

  /** El datáfono ya usa la credencial nueva: la anterior deja de valer. */
  private async promoteNextToken(terminalId: string, tokenHash: string): Promise<void> {
    const promoted = await this.prisma.asSystem((tx) =>
      tx.terminal.updateMany({
        where: { id: terminalId, deviceTokenNextHash: tokenHash },
        data: { deviceTokenHash: tokenHash, deviceTokenNextHash: null, deviceTokenIssuedAt: new Date() },
      }),
    );
    // Otra petición con la misma credencial nueva ya la cambió: sigue valiendo.
    if (promoted.count === 0) {
      const current = await this.prisma.asSystem((tx) =>
        tx.terminal.findFirst({ where: { id: terminalId, deviceTokenHash: tokenHash }, select: { id: true } }),
      );
      if (!current) throw new UnauthorizedException(NOT_PAIRED);
    }
  }
}

export const CurrentDevice = createParamDecorator((_data: unknown, ctx: ExecutionContext): PosDevice => {
  const device = ctx.switchToHttp().getRequest<{ posDevice?: PosDevice }>().posDevice;
  if (!device) throw new UnauthorizedException(NOT_PAIRED);
  return device;
});
