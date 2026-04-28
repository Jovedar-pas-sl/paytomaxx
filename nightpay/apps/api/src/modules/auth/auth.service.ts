import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MetricsService } from '../metrics/metrics.service';
import { LockoutService } from './lockout.service';
import type { JwtPayload, LoginRequest, LoginResponse } from '@nightpay/contracts';

const BCRYPT_ROUNDS = 10;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12h — staff interno

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly prisma: PrismaService;
  private readonly jwt: JwtService;
  private readonly lockout: LockoutService;
  private readonly audit: AuditService;
  private readonly metrics: MetricsService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(JwtService) jwt: JwtService,
    @Inject(LockoutService) lockout: LockoutService,
    @Inject(AuditService) audit: AuditService,
    @Inject(MetricsService) metrics: MetricsService,
  ) {
    this.prisma = prisma;
    this.jwt = jwt;
    this.lockout = lockout;
    this.audit = audit;
    this.metrics = metrics;
  }

  async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, BCRYPT_ROUNDS);
  }

  async verifyPassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  /**
   * Login. Cross-tenant por diseno (no sabemos tenant antes del lookup).
   * - Lockout via Redis (multi-nodo safe).
   * - Audit log de exitos y fallos.
   */
  async login(input: LoginRequest, ip?: string, userAgent?: string): Promise<LoginResponse> {
    const key = input.email.toLowerCase();

    const lock = await this.lockout.isLocked(key);
    if (lock.locked) {
      this.metrics.authLogins.inc({ outcome: 'locked' });
      this.logger.warn(`Login locked for ${key} (${lock.ttlSeconds}s remaining)`);
      await this.audit.log({
        action: 'auth.login.locked',
        actorEmail: input.email,
        ip,
        userAgent,
        payload: { ttlSeconds: lock.ttlSeconds },
      });
      throw new UnauthorizedException('Too many attempts; try again later');
    }

    const user = await this.prisma.asSystem((tx) =>
      tx.user.findUnique({
        where: { email: input.email },
        include: { venue: true },
      }),
    );

    if (!user || user.deletedAt) {
      const result = await this.lockout.recordFailure(key);
      this.metrics.authLogins.inc({ outcome: 'failed' });
      await this.audit.log({
        action: 'auth.login.failed',
        actorEmail: input.email,
        ip,
        userAgent,
        payload: { reason: 'unknown_user', count: result.count, locked: result.locked },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    const ok = await this.verifyPassword(input.password, user.passwordHash);
    if (!ok) {
      const result = await this.lockout.recordFailure(key);
      this.metrics.authLogins.inc({ outcome: 'failed' });
      await this.audit.log({
        action: 'auth.login.failed',
        actorId: user.id,
        actorEmail: user.email,
        tenantId: user.tenantId,
        ip,
        userAgent,
        payload: { reason: 'bad_password', count: result.count, locked: result.locked },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    if (input.venueSlug && input.venueSlug !== user.venue.slug) {
      this.logger.warn(
        `Login rejected: user ${user.email} requested venue ${input.venueSlug} but belongs to ${user.venue.slug}`,
      );
      await this.audit.log({
        action: 'auth.login.failed',
        actorId: user.id,
        actorEmail: user.email,
        tenantId: user.tenantId,
        ip,
        userAgent,
        payload: { reason: 'venue_mismatch', requested: input.venueSlug },
      });
      throw new UnauthorizedException('Invalid venue for this user');
    }

    await this.lockout.clear(key);

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

    this.metrics.authLogins.inc({ outcome: 'ok' });
    await this.audit.log({
      action: 'auth.login.ok',
      actorId: user.id,
      actorEmail: user.email,
      tenantId: user.tenantId,
      ip,
      userAgent,
    });

    this.logger.log(`Login OK: ${user.email} (${user.role}) -> venue ${user.venue.slug}`);

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
