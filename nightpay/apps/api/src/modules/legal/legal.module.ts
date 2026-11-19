import { Module } from '@nestjs/common';
import { LegalController } from './legal.controller';

/** Aviso legal, Privacidad, Cookies y Condiciones (/legal/…). */
@Module({ controllers: [LegalController] })
export class LegalModule {}
