import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../common/prisma/prisma.service';

const logger = new Logger('PhotoHashes');

/**
 * Las huellas de las fotos de perfil de un grupo de personas del local, para
 * que las listas del panel (compañeras, camareros, personal) dibujen su foto.
 * Una lista no debe caerse por una foto: si falla, se avisa en el log y salen
 * las iniciales.
 */
export async function photoHashesOf(prisma: Pick<PrismaService, 'withTenant'>, tenantId: string, userIds: readonly string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  try {
    const rows = await prisma.withTenant(tenantId, (tx) =>
      tx.userPhoto.findMany({ where: { tenantId, userId: { in: [...userIds] } }, select: { userId: true, contentHash: true } }),
    );
    return new Map(rows.map((r) => [r.userId, r.contentHash.trim()]));
  } catch (err) {
    logger.warn(`No se pudieron leer las fotos de ${userIds.length} personas: ${(err as Error).message}`);
    return new Map();
  }
}
