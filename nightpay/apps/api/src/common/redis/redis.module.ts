import { Global, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Cliente ioredis singleton compartido para:
 *  - LockoutService (login brute-force tracking)
 *  - Health check (ping)
 *  - Refresh token revocation list (futuro)
 *
 * NO usar para BullMQ (BullModule maneja su propio pool).
 * NO usar para Socket.io adapter (RedisIoAdapter maneja sus pub/sub).
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis => {
        // ioredis parsea la URL directamente — incluye password, db, etc
        const client = new Redis(config.getOrThrow<string>('REDIS_URL'), {
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
          lazyConnect: false,
        });
        const logger = new Logger('RedisClient');
        client.on('error', (err) => logger.error(`Redis error: ${err.message}`));
        client.on('ready', () => logger.log('Redis connected'));
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async onModuleDestroy(): Promise<void> {
    // Note: el client se inyecta — para cerrar limpio en prod, usar lifecycle del provider
  }
}
