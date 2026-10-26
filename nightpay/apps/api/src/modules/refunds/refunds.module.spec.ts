import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { ApprovalsCoreModule } from '../approvals/approvals-core.module';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { RefundsModule } from './refunds.module';
import { RefundsService } from './refunds.service';
import { REFUNDS_SERVICE } from './refunds.token';

@Module({})
class Empty {}

describe('RefundsModule: el saldo encuentra RefundsService por su nombre', () => {
  it('ModuleRef.get(REFUNDS_SERVICE) da el mismo RefundsService (antes: «could not find RefundsService element» y 500 al devolver el saldo a la tarjeta)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [RefundsModule] })
      .overrideModule(PaymentsModule)
      .useModule(Empty)
      .overrideModule(AuthModule)
      .useModule(Empty)
      .overrideModule(ApprovalsCoreModule)
      .useModule(Empty)
      .useMocker(() => ({}))
      .compile();
    const byName = moduleRef.get<RefundsService>(REFUNDS_SERVICE, { strict: false });
    expect(byName).toBeInstanceOf(RefundsService);
    expect(byName).toBe(moduleRef.get(RefundsService, { strict: false }));
  });
});
