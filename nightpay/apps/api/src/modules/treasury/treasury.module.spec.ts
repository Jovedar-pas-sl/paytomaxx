import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TreasuryModule } from './treasury.module';

describe('TreasuryModule', () => {
  it('no crea su propio PrismaService (otro cliente y otro pool): usa el global', () => {
    const providers = Reflect.getMetadata('providers', TreasuryModule) as unknown[];
    expect(providers).not.toContain(PrismaService);
  });
});
