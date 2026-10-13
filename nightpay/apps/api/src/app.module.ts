import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ClsModule } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { AuthGuard } from './common/guards/auth.guard';
import { IpRateLimitGuard } from './common/guards/ip-rate-limit.guard';
import { EmailModule } from './common/email/email.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { GatewaysModule } from './modules/gateways/gateways.module';
import { HealthController } from './modules/health/health.controller';
import { MetricsModule } from './modules/metrics/metrics.module';
import { OperatorsModule } from './modules/operators/operators.module';
import { TreasuryModule } from './modules/treasury/treasury.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { QueuesModule } from './modules/queues/queues.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { RefundsModule } from './modules/refunds/refunds.module';
import { TerminalsModule } from './modules/terminals/terminals.module';
import { CartaModule } from './modules/carta/carta.module';
import { ReportsModule } from './modules/reports/reports.module';
import { NightsModule } from './modules/nights/nights.module';
import { IncidentsModule } from './modules/incidents/incidents.module';
import { VenuesModule } from './modules/venues/venues.module';
import { WalletsModule } from './modules/wallets/wallets.module';
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
      // Middleware-level mount so context is alive before any guard runs.
      // (Previously mounted as guard — ran in parallel with AuthGuard so
      //  isActive() returned false during auth.guard.canActivate.)
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: () => randomUUID(),
        setup: (cls, req: FastifyRequest) => {
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
    RedisModule,
    EmailModule,
    AuditModule,
    MetricsModule,
    QueuesModule,
    GatewaysModule,
    RealtimeModule,
    AuthModule,
    VenuesModule,
    PaymentsModule,
    RefundsModule,
    OperatorsModule,
    AdminModule,
    TreasuryModule,
    TerminalsModule,
    CartaModule,
    ReportsModule,
    NightsModule,
    IncidentsModule,
    WalletsModule,
    WebhooksModule,
  ],
  controllers: [HealthController],
  // Orden importa: IpRateLimit corre antes que AuthGuard para que un ataque de
  // brute-force/enumeración no consuma ciclos de JWT verify.
  providers: [
    { provide: APP_GUARD, useClass: IpRateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
