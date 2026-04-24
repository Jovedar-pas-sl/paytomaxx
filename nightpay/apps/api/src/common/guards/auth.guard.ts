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
import { JwtPayloadSchema, type JwtPayload } from '@nightpay/contracts';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { RequestContext } from '../context/request-context';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);
  private readonly jwt: JwtService;
  private readonly reflector: Reflector;
  private readonly cls: ClsService<{ ctx: RequestContext }>;

  constructor(
    @Inject(JwtService) jwt: JwtService,
    @Inject(Reflector) reflector: Reflector,
    @Inject(ClsService) cls: ClsService<{ ctx: RequestContext }>,
  ) {
    this.jwt = jwt;
    this.reflector = reflector;
    this.cls = cls;
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

    const header = req.headers['authorization'];
    const token =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length).trim()
        : null;

    if (!token) throw new UnauthorizedException('Missing bearer token');

    let raw: unknown;
    try {
      raw = await this.jwt.verifyAsync(token);
    } catch (err) {
      this.logger.debug(`JWT verify failed: ${(err as Error).message}`);
      throw new UnauthorizedException('Invalid token');
    }

    const parsed = JwtPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn('JWT payload failed zod validation', parsed.error.flatten());
      throw new UnauthorizedException('Malformed token');
    }

    req.user = parsed.data;

    // Inyectar contexto en CLS para que Prisma middleware lo recoja.
    // Resiliente: si CLS no está activo (ej. tests, bootstrap), no crashea.
    if (this.cls.isActive()) {
      this.cls.set('ctx', {
        tenantId: parsed.data.tenantId,
        userId: parsed.data.sub,
        role: parsed.data.role,
        venueSlug: parsed.data.venueSlug,
      });
    } else {
      this.logger.warn('CLS context not active — tenant filtering will not apply');
    }

    return true;
  }
}
