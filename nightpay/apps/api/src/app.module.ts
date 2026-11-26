import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ClsModule } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { configModuleOptions } from './config/env';
import { requestTraceId } from './common/context/trace-id';
import { requestDevice } from './common/http/client-device';
import { AuthGuard } from './common/guards/auth.guard';
import { IpRateLimitGuard } from './common/guards/ip-rate-limit.guard';
import { EmailModule } from './common/email/email.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { startRequestTxGate } from './common/prisma/prisma.service';
import { RedisModule } from './common/redis/redis.module';
import { AdminModule } from './modules/admin/admin.module';
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { BtcpayModule } from './modules/btcpay/btcpay.module';
import { BitcoinCashModule } from './modules/bitcoin-cash/bitcoin-cash.module';
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
import { ProfileModule } from './modules/profile/profile.module';
import { ReportsModule } from './modules/reports/reports.module';
import { NightsModule } from './modules/nights/nights.module';
import { IncidentsModule } from './modules/incidents/incidents.module';
import { ClientErrorsModule } from './modules/client-errors/client-errors.module';
import { BankReconModule } from './modules/bank-recon/bank-recon.module';
import { PosDeviceModule } from './modules/pos-device/pos-device.module';
import { SuperAdminModule } from './modules/superadmin/superadmin.module';
import { VenuesModule } from './modules/venues/venues.module';
import { MoneyMapModule } from './modules/money-map/money-map.module';
import { OxioPaySettlementsModule } from './modules/oxiopay-settlements/oxiopay-settlements.module';
import { WalletsModule } from './modules/wallets/wallets.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { HomeTopUpModule } from './modules/home-topup/home-topup.module';
import { CustomerDisplayModule } from './modules/customer-display/customer-display.module';
import { ReservationsModule } from './modules/reservations/reservations.module';
import { LegalModule } from './modules/legal/legal.module';
import { PartyModule } from './modules/party/party.module';
import { PartnerModule } from './modules/partner/partner.module';

@Module({
  imports: [
    // Validado y convertido con el esquema zod de config/env.ts: config.get()
    // devuelve números/booleanos y ve los valores por defecto.
    ConfigModule.forRoot(configModuleOptions()),
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
          // X-Trace-Id del cliente (X-Request-Id en la API de socios) solo si
          // es corto y limpio (se guarda en audit_events y se devuelve en los
          // errores); si no, uno nuevo.
          const traceId = requestTraceId(req, cls.getId());
          // El dispositivo y la IP real (la misma que los límites de peticiones):
          // van con el cobro en los eventos `payment.device` (detalle del pago).
          const device = req?.headers ? requestDevice(req) : undefined;
          cls.set('ctx', { traceId, ...(device ? { device } : {}) });
          // Sus transacciones, de una en una: una petición no ocupa varias
          // conexiones del pool a la vez (PrismaService, RequestTxGate).
          startRequestTxGate(cls);
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
    MoneyMapModule,
    PaymentsModule,
    // «Pagar con bitcoin» (BTCPay): apagado salvo BTCPAY_ENABLED.
    BtcpayModule,
    BitcoinCashModule,
    RefundsModule,
    OperatorsModule,
    AdminModule,
    TreasuryModule,
    TerminalsModule,
    CartaModule,
    ProfileModule,
    ReportsModule,
    NightsModule,
    IncidentsModule,
    ClientErrorsModule,
    BankReconModule,
    PosDeviceModule,
    SuperAdminModule,
    OxioPaySettlementsModule,
    ApprovalsModule,
    WalletsModule,
    WebhooksModule,
    // «Cargar saldo antes de llegar»: el enlace del local (/r/<código>) y la ficha en recepción.
    HomeTopUpModule,
    // «Pantalla del cliente»: la tablet de la barra con el importe y el QR del cobro.
    CustomerDisplayModule,
    ReservationsModule,
    LegalModule,
    // OxioParty (EDITION=party): casetas y ajustes de la fiesta; con club, 404.
    PartyModule,
    // API de socios (/v1/partner): apagada salvo PARTNER_API_ENABLED.
    PartnerModule,
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
