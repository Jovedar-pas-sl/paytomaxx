import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LockoutService } from './lockout.service';
import { RefreshTokenService } from './refresh-token.service';
import { TotpAttemptsService } from './totp-attempts.service';
import { TotpEnrollmentService } from './totp-enrollment.service';
import { TotpController } from './totp.controller';
import { TotpService } from './totp.service';

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
    AuthService,
    TotpService,
    TotpAttemptsService,
    TotpEnrollmentService,
    LockoutService,
    RefreshTokenService,
  ],
  controllers: [AuthController, TotpController],
  exports: [AuthService, TotpService, RefreshTokenService, JwtModule],
})
export class AuthModule {}
