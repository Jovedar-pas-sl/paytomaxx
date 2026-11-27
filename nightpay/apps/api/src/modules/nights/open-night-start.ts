import type { PrismaService } from '../../common/prisma/prisma.service';
import { zStart } from './night-rules';

/**
 * Desde dónde cuenta la noche abierta del local (el cierre de la anterior,
 * como su Z en vivo); null si no hay ninguna abierta. Para el cierre a
 * ciegas: unas fechas que llegan hasta aquí tocan la caja de esta noche.
 */
export async function openNightStart(prisma: PrismaService, tenantId: string): Promise<Date | null> {
  const open = await prisma.asSystem((tx) =>
    tx.venueNight.findFirst({ where: { tenantId, closedAt: null }, orderBy: { openedAt: 'desc' }, select: { openedAt: true } }),
  );
  if (!open) return null;
  const previous = await prisma.asSystem((tx) =>
    tx.venueNight.findFirst({
      where: { tenantId, closedAt: { not: null, lte: open.openedAt } },
      orderBy: { closedAt: 'desc' },
      select: { closedAt: true, zReport: true },
    }),
  );
  return zStart(previous, open.openedAt).from;
}
