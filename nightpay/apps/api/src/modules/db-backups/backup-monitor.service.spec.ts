import { describe, it, expect, vi, afterEach } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { BackupMonitorService } from './backup-monitor.service';

const SETTINGS: Record<string, string> = {
  BACKUP_S3_ENDPOINT: 'https://acc.r2.cloudflarestorage.com',
  BACKUP_S3_BUCKET: 'copias',
  BACKUP_S3_PREFIX: 'nightpay-postgres/',
  BACKUP_S3_ACCESS_KEY_ID: 'key',
  BACKUP_S3_SECRET_ACCESS_KEY: 'secret',
};

function makeMonitor(env: Record<string, string> = SETTINGS) {
  return new BackupMonitorService({ get: (k: string) => env[k] } as never);
}

const now = new Date('2026-10-14T09:00:00Z');

afterEach(() => vi.restoreAllMocks());

describe('vigilante de copias', () => {
  it('sin variables no consulta nada', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    expect(await makeMonitor({}).verdict(now)).toEqual({ kind: 'unmonitored' });
    expect(send).not.toHaveBeenCalled();
  });

  it('busca la copia más reciente entre varias páginas y guarda el resultado 10 min', async () => {
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValueOnce({
        Contents: [{ LastModified: new Date('2026-10-12T03:00:00Z') }],
        IsTruncated: true,
        NextContinuationToken: 'p2',
      } as never)
      .mockResolvedValueOnce({
        Contents: [{ LastModified: new Date('2026-10-14T03:00:00Z') }, { LastModified: new Date('2026-10-13T03:00:00Z') }],
        IsTruncated: false,
      } as never);
    const monitor = makeMonitor();
    expect(await monitor.verdict(now)).toEqual({ kind: 'ok', lastBackupAt: new Date('2026-10-14T03:00:00Z') });
    expect(send).toHaveBeenCalledTimes(2);
    const firstInput = (send.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(firstInput).toMatchObject({ Bucket: 'copias', Prefix: 'nightpay-postgres/' });
    await monitor.verdict(new Date(now.getTime() + 5 * 60_000));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('copia vieja o sin acceso al almacenamiento → aviso', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValueOnce({
      Contents: [{ LastModified: new Date('2026-10-12T03:00:00Z') }],
      IsTruncated: false,
    } as never);
    expect(await makeMonitor().verdict(now)).toMatchObject({ kind: 'stale' });

    const denied = Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValueOnce(denied);
    expect(await makeMonitor().verdict(now)).toMatchObject({ kind: 'stale', error: 'AccessDenied' });
  });
});
