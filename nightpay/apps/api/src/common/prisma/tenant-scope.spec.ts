import { describe, it, expect } from 'vitest';
import { scopeToTenant } from './tenant-scope';

describe('scopeToTenant', () => {
  it('no modifica la consulta original', () => {
    const original = { action: 'findMany', args: { where: { status: 'X' } } };
    const scoped = scopeToTenant(original, 't-A');
    expect(scoped.args).toEqual({ where: { status: 'X', tenantId: 't-A' } });
    expect(original.args).toEqual({ where: { status: 'X' } });
  });

  it('upsert: where y create; createMany / createManyAndReturn: cada fila', () => {
    expect(scopeToTenant({ action: 'upsert', args: { where: { id: 1 }, create: { a: 1 }, update: {} } }, 't').args).toEqual({
      where: { id: 1, tenantId: 't' },
      create: { a: 1, tenantId: 't' },
      update: {},
    });
    for (const action of ['createMany', 'createManyAndReturn']) {
      expect(scopeToTenant({ action, args: { data: [{ a: 1 }, { a: 2 }] } }, 't').args).toEqual({
        data: [
          { a: 1, tenantId: 't' },
          { a: 2, tenantId: 't' },
        ],
      });
    }
  });

  it('update/delete filtran el where; create pone el local en data', () => {
    expect(scopeToTenant({ action: 'deleteMany', args: {} }, 't').args).toEqual({ where: { tenantId: 't' } });
    expect(scopeToTenant({ action: 'create', args: { data: { tenantId: 'otro' } } }, 't').args).toEqual({
      data: { tenantId: 't' },
    });
  });
});
