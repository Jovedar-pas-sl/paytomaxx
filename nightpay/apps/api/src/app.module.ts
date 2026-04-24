import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ClsModule } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { AuthGuard } from './common/guards/auth.guard';
import { PrismaModule } from './common/prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthController } from './modules/health/health.controller';
import { VenuesModule } from './modules/venues/venues.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env.local', '.env'],
    }),
    // nestjs-cls con Fastify: el middleware de Express no funciona aquí.
    // Usamos `guard.mount` para que el CLS se monte como guard global, que
    // en NestJS corre ANTES que otros guards (AuthGuard) y garantiza que
    // el contexto esté disponible cuando los guards lo usan.
    // Ver https://papooch.github.io/nestjs-cls/setting-up-cls-context/using-a-guard
    ClsModule.forRoot({
      global: true,
      guard: {
        mount: true,
        generateId: true,
        idGenerator: () => randomUUID(),
        setup: (cls, ctx) => {
          const req = ctx.switchToHttp().getRequest<FastifyRequest>();
          const headerTraceId = req?.headers?.['x-trace-id'];
          const traceId =
            typeof headerTraceId === 'string' && headerTraceId.length > 0
              ? headerTraceId
              : cls.getId();
          cls.set('ctx', { traceId });
        },
      },
    }),
    PrismaModule,
    AuthModule,
    VenuesModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    // RolesGuard se aplica por controlador con @UseGuards — no global
  ],
})
export class AppModule {}
