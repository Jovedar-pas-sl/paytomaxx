import type { Role } from '@nightpay/contracts';

export interface RequestContext {
  tenantId?: string;
  userId?: string;
  role?: Role;
  venueSlug?: string;
  traceId?: string;
  /** Dentro de PrismaService.acrossVenues: consulta entre locales a propósito. */
  acrossVenues?: boolean;
}
