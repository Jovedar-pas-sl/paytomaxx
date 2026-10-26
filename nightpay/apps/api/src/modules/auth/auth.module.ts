import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AccessRevocationService } from './access-revocation.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LockoutService } from './lockout.service';
import { LoginTicketService } from './login-ticket.service';
import { RefreshTokenService } from './refresh-token.service';
import { StaffSessionTransport } from './staff-session.transport';
import { TotpAttemptsService } from './totp-attempts.service';
import { TotpEnrollmentService } from './totp-enrollment.service';
import { TotpController } from './totp.controller';
import { TotpService } from './totp.service';
import { TelegramService } from '../incidents/telegram.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          issuer: 'nightpay',
          audience: 'nightpay-internal',
        },
      }),
    }),
  ],
  providers: [
    AccessRevocationService,
    AuthService,
    TotpService,
    TotpAttemptsService,
    TotpEnrollmentService,
    LockoutService,
    LoginTicketService,
    RefreshTokenService,
    StaffSessionTransport,
    // Aviso al activar la 2FA de un super-admin (Telegram del entorno).
    TelegramService,
  ],
  controllers: [AuthController, TotpController],
  exports: [AuthService, TotpService, RefreshTokenService, AccessRevocationService, JwtModule],
})
export class AuthModule {}
