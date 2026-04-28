import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ClsModule } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { AuthGuard } from './common/guards/auth.guard';
import { PrismaModule } from './common/prisma/prisma.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { GatewaysModule } from './modules/gateways/gateways.module';
import { HealthController } from './modules/health/health.controller';
import { PaymentsModule } from './modules/payments/payments.module';
import { QueuesModule } from './modules/queues/queues.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { RefundsModule } from './modules/refunds/refunds.module';
import { VenuesModule } from './modules/venues/venues.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env.local', '.env'],
    }),
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
    QueuesModule,
    GatewaysModule,
    RealtimeModule,
    AuthModule,
    VenuesModule,
    PaymentsModule,
    RefundsModule,
    AdminModule,
    WebhooksModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
