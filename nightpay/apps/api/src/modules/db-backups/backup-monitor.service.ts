import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { DEFAULT_BACKUP_MAX_AGE_HOURS, backupVerdict, type BackupStatus, type BackupVerdict } from './backup-check';

/** La bandeja de incidencias se consulta a menudo: el almacenamiento, como mucho cada 10 min. */
const CACHE_MS = 10 * 60_000;
/** Dokploy guarda N copias; con esto sobra para encontrar la última. */
const MAX_PAGES = 20;
/** Tiempo máximo de cada consulta al almacenamiento (la bandeja y los avisos no esperan más). */
const LIST_TIMEOUT_MS = 10_000;

/**
 * Mira cuándo fue la última copia de la base de datos en el almacenamiento
 * S3 donde las deja Dokploy (ver docs/BACKUPS.md). Variables (opcionales):
 * BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_PREFIX,
 * BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY, BACKUP_S3_REGION
 * (por defecto "auto", el de Cloudflare R2) y BACKUP_MAX_AGE_HOURS.
 * Basta una clave de solo lectura.
 */
@Injectable()
export class BackupMonitorService {
  private readonly logger = new Logger(BackupMonitorService.name);
  private readonly config: ConfigService;
  private cache: { at: number; status: BackupStatus } | null = null;
  /** La última copia que se vio (si luego falla la consulta, cuenta esta). */
  private lastGood: Date | null = null;
  private client: S3Client | null = null;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.config = config;
  }

  async verdict(now: Date = new Date()): Promise<BackupVerdict> {
    const maxAge = Number(this.config.get<string>('BACKUP_MAX_AGE_HOURS')) || DEFAULT_BACKUP_MAX_AGE_HOURS;
    return backupVerdict(await this.status(now), now, maxAge);
  }

  private async status(now: Date): Promise<BackupStatus> {
    if (this.cache && now.getTime() - this.cache.at < CACHE_MS) return this.cache.status;
    const status = await this.read();
    this.cache = { at: now.getTime(), status };
    return status;
  }

  private settings() {
    const get = (k: string) => this.config.get<string>(k)?.trim() || null;
    const bucket = get('BACKUP_S3_BUCKET');
    const endpoint = get('BACKUP_S3_ENDPOINT');
    const accessKeyId = get('BACKUP_S3_ACCESS_KEY_ID');
    const secretAccessKey = get('BACKUP_S3_SECRET_ACCESS_KEY');
    if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) return null;
    return {
      bucket,
      prefix: get('BACKUP_S3_PREFIX') ?? undefined,
      endpoint,
      region: get('BACKUP_S3_REGION') ?? 'auto',
      accessKeyId,
      secretAccessKey,
    };
  }

  private async read(): Promise<BackupStatus> {
    const s = this.settings();
    if (!s) return { configured: false, lastBackupAt: null, error: null };
    this.client ??= new S3Client({
      endpoint: s.endpoint,
      region: s.region,
      forcePathStyle: true,
      credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
    });
    try {
      let latest: Date | null = null;
      let token: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const out = await this.client.send(
          new ListObjectsV2Command({ Bucket: s.bucket, Prefix: s.prefix, ContinuationToken: token }),
          { abortSignal: AbortSignal.timeout(LIST_TIMEOUT_MS) },
        );
        for (const obj of out.Contents ?? []) {
          if (obj.LastModified && (!latest || obj.LastModified > latest)) latest = obj.LastModified;
        }
        if (!out.IsTruncated || !out.NextContinuationToken) break;
        token = out.NextContinuationToken;
      }
      if (latest) this.lastGood = latest;
      return { configured: true, lastBackupAt: latest, error: null };
    } catch (err) {
      const message = (err as Error).name || (err as Error).message || 'error';
      this.logger.warn(`No se pudo consultar el almacenamiento de las copias: ${message}`);
      return { configured: true, lastBackupAt: this.lastGood, error: message };
    }
  }
}
