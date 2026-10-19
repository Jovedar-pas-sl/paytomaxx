import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { AuditService } from '../audit/audit.service';
import type { PosDevice } from './device.guard';

const META_KEY = 'np:device-rate-limit';

export interface DeviceRateLimitConfig {
  max: number;
  windowSec: number;
  scope: string;
}

/** Audit que acaba en la bandeja de incidencias (pos_reception_limit). */
export const RECEPTION_LIMIT_ACTION = 'pos.reception_limit_exceeded';

/**
 * Tope por datáfono (no por IP): una credencial robada usada desde varias IPs
 * sigue frenada. Va DESPUÉS de DeviceGuard: `@UseGuards(DeviceGuard, DeviceRateLimitGuard)`.
 */
export const DeviceRateLimit = (config: DeviceRateLimitConfig) => SetMetadata(META_KEY, config);

/**
 * Ventana fija en Redis por datáfono: nightpay:devrl:<scope>:<terminalId>:<bucket>.
 * Pasado el tope, 429; la primera vez en cada ventana queda en la auditoría
 * (y en Incidencias) para que el dueño lo vea.
 */
@Injectable()
export class DeviceRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(DeviceRateLimitGuard.name);
  private readonly reflector: Reflector;
  private readonly redis: Redis;
  private readonly audit: AuditService;

  constructor(
    @Inject(Reflector) reflector: Reflector,
    @Inject(REDIS_CLIENT) redis: Redis,
    @Inject(AuditService) audit: AuditService,
  ) {
    this.reflector = reflector;
    this.redis = redis;
    this.audit = audit;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const config = this.reflector.getAllAndOverride<DeviceRateLimitConfig | undefined>(META_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!config) return true;
    const device = ctx.switchToHttp().getRequest<{ posDevice?: PosDevice }>().posDevice;
    // Sin datáfono no se sigue: este guard va siempre detrás de DeviceGuard.
    if (!device) throw new HttpException('Datáfono sin vincular', HttpStatus.UNAUTHORIZED);

    const bucket = Math.floor(Date.now() / 1000 / config.windowSec);
    const key = `nightpay:devrl:${config.scope}:${device.terminalId}:${bucket}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, config.windowSec);
    if (count <= config.max) return true;

    this.logger.warn(`Tope por datáfono: scope=${config.scope} terminal=${device.terminalId} ${count}/${config.max}`);
    if (count === config.max + 1) {
      await this.audit.log({
        action: RECEPTION_LIMIT_ACTION,
        tenantId: device.tenantId,
        targetType: 'Terminal',
        targetId: device.terminalId,
        payload: { limit: 'rate', scope: config.scope, max: config.max, windowSec: config.windowSec, terminalLabel: device.label },
      });
    }
    throw new HttpException(
      { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: 'Demasiadas recargas seguidas en este datáfono: espera un minuto' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
