import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
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
  providers: [AuthService, TotpService],
  controllers: [AuthController],
  exports: [AuthService, TotpService, JwtModule],
})
export class AuthModule {}
