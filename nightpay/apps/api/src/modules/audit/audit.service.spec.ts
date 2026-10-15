import { describe, it, expect, vi } from 'vitest';
import { AuditService, truncatePayload, MAX_AUDIT_STRING } from './audit.service';

describe('truncatePayload', () => {
  it('corta los textos largos (también anidados y en listas) sin tocar el original', () => {
    const long = 'x'.repeat(MAX_AUDIT_STRING + 100);
    const original = { error: long, nested: { stack: long, n: 5 }, list: [long, 'corto'], ok: true, nada: null };
    const out = truncatePayload(original);
    expect((out.error as string).length).toBeLessThanOrEqual(MAX_AUDIT_STRING + 20);
    expect((out.error as string).endsWith('…[cortado]')).toBe(true);
    expect(((out.nested as Record<string, unknown>).stack as string).length).toBeLessThanOrEqual(MAX_AUDIT_STRING + 20);
    expect((out.list as string[])[1]).toBe('corto');
    expect(out.ok).toBe(true);
    expect(out.nada).toBeNull();
    expect(original.error.length).toBe(MAX_AUDIT_STRING + 100);
  });

  it('no baja infinitamente en objetos muy anidados', () => {
    let deep: Record<string, unknown> = { v: 'fin' };
    for (let i = 0; i < 20; i++) deep = { d: deep };
    expect(() => truncatePayload(deep)).not.toThrow();
    expect(JSON.stringify(truncatePayload(deep))).toContain('[demasiado anidado]');
  });
});

describe('AuditService.log', () => {
  it('guarda el payload recortado y el traceId del contexto', async () => {
    const create = vi.fn().mockResolvedValue({});
    const prisma = { auditEvent: { create } };
    const cls = { get: vi.fn().mockReturnValue({ traceId: 't-1' }) };
    await new AuditService(prisma as never, cls as never).log({
      action: 'refund.failed',
      payload: { error: 'e'.repeat(5000) },
    });
    const data = create.mock.calls[0]![0].data;
    expect(data.traceId).toBe('t-1');
    expect((data.payload.error as string).length).toBeLessThan(600);
  });
});
