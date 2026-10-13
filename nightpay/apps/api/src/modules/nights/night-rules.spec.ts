import { describe, it, expect } from 'vitest';
import { autoCloseAt, decideClose } from './night-rules';

describe('cerrar la noche', () => {
  it('sin cobros pendientes → se cierra', () => {
    expect(decideClose({ pendingCount: 0, force: false, role: 'MANAGER', note: undefined })).toEqual({ ok: true });
  });

  it('con cobros sin resolver → no se cierra', () => {
    expect(decideClose({ pendingCount: 2, force: false, role: 'OWNER', note: undefined })).toEqual({
      ok: false,
      reason: 'pending',
    });
  });

  it('cerrar igualmente: solo el dueño y con nota', () => {
    expect(decideClose({ pendingCount: 2, force: true, role: 'MANAGER', note: 'lo miro mañana' })).toEqual({
      ok: false,
      reason: 'force-owner-only',
    });
    expect(decideClose({ pendingCount: 2, force: true, role: 'OWNER', note: ' ' })).toEqual({
      ok: false,
      reason: 'note-required',
    });
    expect(decideClose({ pendingCount: 2, force: true, role: 'OWNER', note: 'BBVA lo confirma mañana' })).toEqual({
      ok: true,
    });
  });
});

describe('cierre automático a las 08:00', () => {
  const opened = new Date('2026-10-13T20:00:00Z'); // 22:00 de Madrid

  it('antes de las 08:00 sigue abierta', () => {
    expect(autoCloseAt(opened, new Date('2026-10-14T05:59:00Z'))).toBeNull();
  });

  it('a partir de las 08:00 se cierra, con hora de cierre las 08:00', () => {
    expect(autoCloseAt(opened, new Date('2026-10-14T09:30:00Z'))?.toISOString()).toBe('2026-10-14T06:00:00.000Z');
  });
});
