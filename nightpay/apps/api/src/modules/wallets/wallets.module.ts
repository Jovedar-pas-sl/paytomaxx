import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AdminWalletsController, WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

@Module({
  imports: [PrismaModule, AuditModule],
  providers: [WalletsService],
  controllers: [WalletsController, AdminWalletsController],
  exports: [WalletsService],
})
export class WalletsModule {}
