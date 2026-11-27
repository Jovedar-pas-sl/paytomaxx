import { describe, it, expect } from 'vitest';
import { backupVerdict } from './backup-check';
import { backupIncidents } from '../incidents/incident-rules';

const now = new Date('2026-10-14T09:00:00Z');

describe('copias de seguridad', () => {
  it('sin variables → no se vigilan', () => {
    expect(backupVerdict({ configured: false, lastBackupAt: null, error: null }, now, 26)).toEqual({ kind: 'unmonitored' });
  });

  it('copia de hace menos de 26 h → bien; de más, o ninguna, o error → aviso', () => {
    const recent = new Date('2026-10-13T09:30:00Z');
    expect(backupVerdict({ configured: true, lastBackupAt: recent, error: null }, now, 26)).toEqual({
      kind: 'ok',
      lastBackupAt: recent,
    });
    const old = new Date('2026-10-13T06:00:00Z');
    expect(backupVerdict({ configured: true, lastBackupAt: old, error: null }, now, 26)).toMatchObject({ kind: 'stale' });
    expect(backupVerdict({ configured: true, lastBackupAt: null, error: null }, now, 26)).toMatchObject({
      kind: 'stale',
      lastBackupAt: null,
    });
    expect(backupVerdict({ configured: true, lastBackupAt: null, error: 'AccessDenied' }, now, 26)).toMatchObject({
      kind: 'stale',
      error: 'AccessDenied',
    });
  });
});

describe('un fallo al consultar el almacenamiento', () => {
  it('con la última copia buena reciente (recordada) → bien: un fallo de un minuto no es «sin copia»', () => {
    const recent = new Date('2026-10-14T03:00:00Z');
    expect(backupVerdict({ configured: true, lastBackupAt: recent, error: 'TimeoutError' }, now, 26)).toEqual({ kind: 'ok', lastBackupAt: recent });
    const old = new Date('2026-10-13T06:00:00Z');
    expect(backupVerdict({ configured: true, lastBackupAt: old, error: 'TimeoutError' }, now, 26)).toMatchObject({ kind: 'stale', error: 'TimeoutError' });
  });
});

describe('aviso de copias en Incidencias', () => {
  it('sin copia: aviso que se quita solo, uno por día; sin vigilar: solo en producción y se puede revisar', () => {
    const stale = backupIncidents({ kind: 'stale', lastBackupAt: new Date('2026-10-12T02:00:00Z'), error: null }, now, true);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ kind: 'backup_stale', refId: 'stale:2026-10-14', ackable: false });
    expect(stale[0]!.detail).toContain('12/10');

    expect(backupIncidents({ kind: 'unmonitored' }, now, false)).toEqual([]);
    expect(backupIncidents({ kind: 'unmonitored' }, now, true)[0]).toMatchObject({
      kind: 'backup_unmonitored',
      ackable: true,
    });
    expect(backupIncidents({ kind: 'ok', lastBackupAt: now }, now, true)).toEqual([]);
  });
});
