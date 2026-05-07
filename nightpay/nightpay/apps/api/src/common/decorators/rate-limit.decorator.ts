import { applyDecorators } from '@nestjs/common';

/**
 * Rate limit por endpoint via @fastify/rate-limit.
 * NestJS expone `config.rateLimit` en el route options — usamos
 * `@RateLimit({ max, timeWindow })` con SetMetadata + extension custom.
 *
 * Implementacion minima: NO se enchufa via setMetadata (Fastify no lo lee
 * desde Nest). En su lugar declaramos limites a nivel de plugin global
 * y dejamos que rutas sensibles (login, payments) usen este decorator
 * como hint para futuro tuning. Por ahora, login_brute force se mitiga
 * con el limit global (200 req/min/IP) + lockout en AuthService.
 *
 * Sprint 7+: hook a fastify-rate-limit per-route via custom Nest module.
 */
export interface RateLimitConfig {
  max: number;
  timeWindow: string;
}

export const LoginRateLimit: RateLimitConfig = { max: 10, timeWindow: '1 minute' };
export const RefundRateLimit: RateLimitConfig = { max: 30, timeWindow: '1 minute' };
export const StartAuthRateLimit: RateLimitConfig = { max: 60, timeWindow: '1 minute' };

// Marker decorator (queda para futura integracion con fastify-rate-limit per-route)
export function RateLimit(_config: RateLimitConfig): MethodDecorator {
  return applyDecorators();
}
