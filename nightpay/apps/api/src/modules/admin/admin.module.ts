import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OperatorsModule } from '../operators/operators.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [AuthModule, OperatorsModule],
  controllers: [AdminController],
})
export class AdminModule {}
