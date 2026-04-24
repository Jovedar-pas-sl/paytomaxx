import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { JwtPayload, LoginRequest, LoginResponse } from '@nightpay/contracts';

const BCRYPT_ROUNDS = 10;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12h — staff interno, sesiones largas son ok

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly prisma: PrismaService;
  private readonly jwt: JwtService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(JwtService) jwt: JwtService,
  ) {
    this.prisma = prisma;
    this.jwt = jwt;
  }

  async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, BCRYPT_ROUNDS);
  }

  async verifyPassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  /**
   * Login. En esta arquitectura "interna" un user SOLO tiene un tenantId directo.
   * El parámetro opcional `venueSlug` permite a un OWNER autenticarse especificando
   * un venue distinto del default — queda preparado para cuando un owner gestione
   * multiples locales con la misma identidad (fase posterior). Por ahora validamos
   * que el venue corresponda al mismo tenant del user.
   *
   * IMPORTANTE: login es cross-tenant por diseño (aún no sabemos qué tenant).
   * Bypass explícito de RLS via `asSystem()` para este lookup inicial.
   */
  async login(input: LoginRequest): Promise<LoginResponse> {
    const user = await this.prisma.asSystem((tx) =>
      tx.user.findUnique({
        where: { email: input.email },
        include: { venue: true },
      }),
    );

    if (!user || user.deletedAt) {
      // Mismo error para no revelar existencia de cuentas
      throw new UnauthorizedException('Invalid credentials');
    }

    const ok = await this.verifyPassword(input.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    // venueSlug opcional: si lo pasan, debe coincidir con el venue del user
    if (input.venueSlug && input.venueSlug !== user.venue.slug) {
      this.logger.warn(`Login rejected: user ${user.email} requested venue ${input.venueSlug} but belongs to ${user.venue.slug}`);
      throw new UnauthorizedException('Invalid venue for this user');
    }

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      venueSlug: user.venue.slug,
    };

    const accessToken = await this.jwt.signAsync(payload, {
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });

    this.logger.log(`Login OK: ${user.email} (${user.role}) → venue ${user.venue.slug}`);

    return {
      accessToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        tenantId: user.tenantId,
        venueSlug: user.venue.slug,
      },
    };
  }
}
