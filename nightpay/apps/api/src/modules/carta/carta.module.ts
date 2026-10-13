import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CartaController } from './carta.controller';
import { CartaService } from './carta.service';

@Module({
  imports: [AuthModule],
  controllers: [CartaController],
  providers: [CartaService],
  exports: [CartaService],
})
export class CartaModule {}
