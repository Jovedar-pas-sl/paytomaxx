import type { IpRateLimitConfig } from '../../common/guards/ip-rate-limit.guard';

/** Escrituras de la consola: como las sensibles del panel (además del límite global). */
export const SUPERADMIN_WRITE_LIMIT: IpRateLimitConfig = { max: 30, windowSec: 60, scope: 'superadmin-write' };
/** Ver una cuenta de cobro entera: más corto (se lee dinero ajeno). */
export const SUPERADMIN_REVEAL_LIMIT: IpRateLimitConfig = { max: 10, windowSec: 60, scope: 'superadmin-reveal' };
/** Búsquedas (clientes por código/ficha): sin barrer códigos. */
export const SUPERADMIN_SEARCH_LIMIT: IpRateLimitConfig = { max: 60, windowSec: 60, scope: 'superadmin-search' };
