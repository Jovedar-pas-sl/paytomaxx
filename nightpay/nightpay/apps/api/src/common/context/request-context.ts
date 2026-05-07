import type { Role } from '@nightpay/contracts';

export interface RequestContext {
  tenantId?: string;
  userId?: string;
  role?: Role;
  venueSlug?: string;
  traceId?: string;
}
