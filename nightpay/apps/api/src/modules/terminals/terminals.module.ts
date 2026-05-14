import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TerminalsController } from './terminals.controller';
import { TerminalsService } from './terminals.service';

@Module({
  imports: [AuthModule],
  controllers: [TerminalsController],
  providers: [TerminalsService],
  exports: [TerminalsService],
})
export class TerminalsModule {}
