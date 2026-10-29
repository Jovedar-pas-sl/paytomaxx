import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { staffBankRef } from './staff-bank-ref';

const TENANT = 't-1';
const CHICA = 'u-chica';
const row = (o: Record<string, unknown> = {}) => ({
  ref: 12,
  createdByUserId: CHICA,
  providerTxId: 'ORD-OLD',
  attempts: [{ providerTxId: '000123ABC' }],
  ...o,
});

function prismaWith(found: Record<string, unknown> | null) {
  const findFirst = vi.fn(async () => found);
  const prisma = { asSystem: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ payment: { findFirst } })) };
  return { prisma, findFirst };
}

describe('la referencia del cobro para la pantalla «El banco no lo ha confirmado»', () => {
  it('la corta (C-0012) y el pedido del banco del último intento', async () => {
    const { prisma, findFirst } = prismaWith(row());
    await expect(staffBankRef(prisma as never, 'p-1', { userId: CHICA, role: 'OPERATOR', tenantId: TENANT })).resolves.toEqual({
      ref: 'C-0012',
      order: '000123ABC',
    });
    // Solo del local de quien pregunta.
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p-1', tenantId: TENANT } }));
  });

  it('sin intentos: el pedido del cobro; sin nada, null', async () => {
    const legacy = prismaWith(row({ attempts: [] }));
    await expect(staffBankRef(legacy.prisma as never, 'p-1', { userId: CHICA, role: 'OPERATOR', tenantId: TENANT })).resolves.toMatchObject({
      order: 'ORD-OLD',
    });
    const none = prismaWith(row({ attempts: [], providerTxId: null, ref: null }));
    await expect(staffBankRef(none.prisma as never, 'p-1', { userId: 'u-boss', role: 'OWNER', tenantId: TENANT })).resolves.toEqual({
      ref: null,
      order: null,
    });
  });

  it('la chica y el camarero, solo de sus cobros; el encargado y el dueño, de todo el local', async () => {
    const { prisma } = prismaWith(row());
    await expect(staffBankRef(prisma as never, 'p-1', { userId: 'otra', role: 'OPERATOR', tenantId: TENANT })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(staffBankRef(prisma as never, 'p-1', { userId: 'otro', role: 'WAITER', tenantId: TENANT })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(staffBankRef(prisma as never, 'p-1', { userId: 'u-enc', role: 'MANAGER', tenantId: TENANT })).resolves.toMatchObject({
      ref: 'C-0012',
    });
    const missing = prismaWith(null);
    await expect(staffBankRef(missing.prisma as never, 'p-x', { userId: 'u-boss', role: 'OWNER', tenantId: TENANT })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
