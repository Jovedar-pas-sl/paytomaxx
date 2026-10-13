/**
 * Copias de seguridad de la base de datos — reglas puras.
 *
 * Dokploy hace la copia (pg_dump) y la sube a un almacenamiento S3 (R2,
 * Backblaze…). Aquí solo se mira la fecha de la última copia que hay allí:
 * si pasa más de un día sin copias, algo ha fallado y hay que enterarse.
 */

/** Por defecto: una copia al día con algo de margen. */
export const DEFAULT_BACKUP_MAX_AGE_HOURS = 26;

export interface BackupStatus {
  /** Hay variables BACKUP_S3_* para mirar el almacenamiento. */
  configured: boolean;
  lastBackupAt: Date | null;
  /** No se pudo consultar el almacenamiento (credenciales, red…). */
  error: string | null;
}

export type BackupVerdict =
  | { kind: 'ok'; lastBackupAt: Date }
  | { kind: 'unmonitored' }
  | { kind: 'stale'; lastBackupAt: Date | null; error: string | null };

export function backupVerdict(status: BackupStatus, now: Date, maxAgeHours: number): BackupVerdict {
  if (!status.configured) return { kind: 'unmonitored' };
  if (status.error) return { kind: 'stale', lastBackupAt: status.lastBackupAt, error: status.error };
  if (!status.lastBackupAt) return { kind: 'stale', lastBackupAt: null, error: null };
  const ageMs = now.getTime() - status.lastBackupAt.getTime();
  return ageMs > maxAgeHours * 3_600_000
    ? { kind: 'stale', lastBackupAt: status.lastBackupAt, error: null }
    : { kind: 'ok', lastBackupAt: status.lastBackupAt };
}
