import { Inject, Injectable, Logger, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import {
  PARTNER_ERROR_RESPONSES,
  PARTNER_KEY_IN_TEXT_RE,
  PARTNER_SCOPES,
  type PartnerRouteDef,
  type PartnerScope,
} from '@nightpay/contracts';
import { bindTenantContext, type RequestContext } from '../../../common/context/request-context';
import { bearerToken } from '../../../common/guards/staff-token';
import { clientIp, type ClientIpRequest } from '../../../common/http/client-ip';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { PARTNER_AUDIT, partnerAuditPayload } from '../partner-audit';
import { partnerApiMode, partnerApiOn } from '../partner-flag';
import { testHelpersOn } from '../../../config/partner-test-mode';
import { partnerError, PartnerHttpException } from '../http/partner-problem';
import { PARTNER_ROUTE } from '../http/partner-route.meta';
import { PARTNER_CONNECTION_INCLUDE, type PartnerAuth, type PartnerGuardConnection } from './current-connection.decorator';
import { PAUTH_LIMITS, PartnerAuthLimiter } from './partner-auth-limiter';
import { PartnerForeignIpService } from './partner-foreign-ip';
import { PartnerFreezeService } from './partner-freeze';
import { ipInList } from './partner-ip';
import { hashPartnerKey, partnerKeyHint, partnerKeyModeOf } from './partner-key';
import { PartnerRateLimiter } from './partner-rate-limit';

/** 90 días sin una llamada de saldo: la clave se duerme. */
export const DORMANT_AFTER_MS = 90 * 86_400_000;
/** El último uso se apunta como mucho una vez por minuto (como DeviceGuard). */
const LAST_USED_EVERY_MS = 60_000;
/** Redis no responde: no se deja pasar a ciegas. */
const REDIS_DOWN_RETRY_S = 5;

type PartnerRequest = ClientIpRequest & { url: string; body?: unknown; rawBody?: Buffer; partner?: PartnerAuth };

/** Los códigos de error que la ruta documenta (sus respuestas del contrato). */
function routeCodes(def: PartnerRouteDef): Set<string> {
  return new Set(Object.values(def.errorResponses).flatMap((name) => (name ? [...PARTNER_ERROR_RESPONSES[name].codes] : [])));
}

function keyInBody(req: PartnerRequest): boolean {
  const text = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : req.body === undefined ? '' : JSON.stringify(req.body);
  return PARTNER_KEY_IN_TEXT_RE.test(text ?? '');
}

const latest = (...dates: Array<Date | null>) => Math.max(...dates.map((d) => d?.getTime() ?? 0));

/**
 * La puerta de la API de socios (§3.3 del diseño), en este orden:
 *  1. apagada (o en OxioParty), una ruta solo de la demo fuera de la demo o congelada del todo: 404;
 *     `money` congelado: 403 en las de dinero;
 *  2. la clave en el cuerpo: 400; con `Origin`: 403;
 *  3. sin tocar la base: clave bloqueada 401; si no se conoce, cortacircuitos 503 e IP bloqueada 429
 *     (salvo unas pocas claves bien formadas por IP: el paso 5 deja pasar una activa con esa IP en su lista);
 *  4. solo `Bearer oxp_<modo>_<48 hex>` del modo del despliegue;
 *  5. la conexión por el hash (actual o anterior en su solape), en asSystem;
 *  6. la IP entera, antes que el estado, en la lista de la clave y en las del socio;
 *  7. anulada (o el local borrado), caducada, dormida, socio suspendido, en pausa o el local sin su sociedad;
 *  8. el local en el contexto con strictTenancy;
 *  9. basta uno de los permisos de la ruta en los de la clave ∩ el techo del socio;
 * 10. topes por conexión; el último uso y la marca de clave buena.
 */
@Injectable()
export class PartnerKeyGuard implements CanActivate {
  private readonly logger = new Logger(PartnerKeyGuard.name);

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ClsService) private readonly cls: ClsService<{ ctx: RequestContext }>,
    @Inject(PartnerFreezeService) private readonly freeze: PartnerFreezeService,
    @Inject(PartnerAuthLimiter) private readonly limiter: PartnerAuthLimiter,
    @Inject(PartnerRateLimiter) private readonly rates: PartnerRateLimiter,
    @Inject(PartnerForeignIpService) private readonly foreign: PartnerForeignIpService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const def = this.reflector.get<PartnerRouteDef | undefined>(PARTNER_ROUTE, ctx.getHandler());
    if (!def) throw new Error('Ruta de socios sin su definición (@PartnerRoute)');
    const req = ctx.switchToHttp().getRequest<PartnerRequest>();

    // 1. Interruptor y congelación. Las rutas sin clave acaban aquí.
    if (!partnerApiOn()) throw partnerError('not_found');
    // Tercera barrera de las ayudas de prueba (tras el arranque y el módulo): sin tocar Redis ni la base.
    if (def.demoOnly && !(testHelpersOn() && partnerApiMode() === 'test')) throw partnerError('not_found');
    const freeze = await this.redis(() => this.freeze.current());
    if (freeze === 'all') throw partnerError('not_found');
    if (freeze === 'money' && def.money) throw partnerError('partner_api_frozen');
    if (def.scopes.length === 0) return true;

    // 2. La clave solo en Authorization; nada de navegadores.
    if (keyInBody(req)) throw partnerError('api_key_in_body');
    if (req.headers['origin'] !== undefined) throw partnerError('browser_not_allowed');

    // 3. Bloqueos, sin tocar la base.
    const presented = bearerToken(req.headers['authorization']) ?? '';
    const keyHash = hashPartnerKey(presented);
    const ip = clientIp(req);
    const state = await this.redis(() => this.limiter.state(keyHash, ip));
    if (state.keyBlocked) throw partnerError('invalid_api_key');
    if (!state.known && state.breaker) throw partnerError('try_later', {}, PAUTH_LIMITS.breakerS);
    // IP bloqueada: nunca para una clave buena con esa IP en su lista (paso 5). Una aún sin conocer
    // llega a la base solo si tiene la forma y el modo, y pocas por IP; las demás, 429 sin contar fallo.
    const unknownFromBlockedIp = !state.known && state.ipBlocked;
    if (
      unknownFromBlockedIp &&
      (partnerKeyModeOf(presented) !== partnerApiMode() || !(await this.redis(() => this.limiter.lookupFromBlockedIp(ip))))
    ) {
      throw partnerError('rate_limited', {}, PAUTH_LIMITS.ipBlockS);
    }

    // 4. La forma y el entorno.
    const mode = partnerKeyModeOf(presented);
    if (!mode) throw await this.failure(keyHash, ip, 'invalid_api_key');
    if (mode !== partnerApiMode()) throw await this.failure(keyHash, ip, 'wrong_environment');

    // Los rechazos de una clave que existe (IP, estado, permisos) no pasan por el límite global (la
    // exención de /v1/partner): llevan su tope por clave e IP, antes de la base.
    if (await this.redis(() => this.rates.rejectedTooOften(keyHash, ip))) throw partnerError('rate_limited', {}, 60);

    // 5 a 9, contando cada rechazo.
    const now = new Date();
    let conn: PartnerGuardConnection;
    let keyMatch: 'current' | 'previous';
    let effectiveScopes: PartnerScope[];
    try {
      ({ conn, keyMatch, effectiveScopes } = await this.admit(def, keyHash, ip, state.ipBlocked, unknownFromBlockedIp, now));
    } catch (err) {
      if (err instanceof PartnerHttpException && err.code !== 'try_later' && err.code !== 'invalid_api_key') {
        await this.redis(() => this.rates.recordRejection(keyHash, ip));
      }
      throw err;
    }

    // 10. Topes, último uso (solo las llamadas con permiso: GET /me no la mantiene viva) y clave buena.
    const rate = await this.redis(() => this.rates.hit(conn.id, def.money));
    if (!rate.ok) throw partnerError('rate_limited', {}, rate.retryAfter);
    if (!def.scopes.includes('any') && (!conn.lastUsedAt || now.getTime() - conn.lastUsedAt.getTime() > LAST_USED_EVERY_MS)) {
      await this.prisma.asSystem((tx) =>
        tx.partnerConnection.update({ where: { id: conn.id, tenantId: conn.tenantId }, data: { lastUsedAt: now, lastUsedIp: ip } }),
      );
    }
    await this.redis(() => this.limiter.markGood(keyHash));
    req.partner = { connection: conn, keyMatch, keyHint: partnerKeyHint(presented), keyHash, effectiveScopes };
    return true;
  }

  /** Pasos 5 a 9: la conexión, la IP, el estado, el contexto y los permisos. */
  private async admit(
    def: PartnerRouteDef,
    keyHash: string,
    ip: string | null,
    ipBlocked: boolean,
    unknownFromBlockedIp: boolean,
    now: Date,
  ): Promise<{ conn: PartnerGuardConnection; keyMatch: 'current' | 'previous'; effectiveScopes: PartnerScope[] }> {
    // 5. La conexión.
    const conn = await this.prisma.asSystem((tx) =>
      tx.partnerConnection.findFirst({
        where: { OR: [{ keyHash }, { prevKeyHash: keyHash, prevKeyExpiresAt: { gt: now } }] },
        include: PARTNER_CONNECTION_INCLUDE,
      }),
    );
    if (!conn) {
      // Una inventada desde la IP bloqueada: el mismo 429, sin contar fallo.
      if (unknownFromBlockedIp) throw partnerError('rate_limited', {}, PAUTH_LIMITS.ipBlockS);
      if (await this.redis(() => this.limiter.isRetired(keyHash))) throw partnerError('api_key_rotated');
      throw await this.failure(keyHash, ip, 'invalid_api_key');
    }
    if (ipBlocked && !(conn.status === 'ACTIVE' && ipInList(ip, conn.ipAllowlist))) {
      throw partnerError('rate_limited', {}, PAUTH_LIMITS.ipBlockS);
    }
    const keyMatch = conn.keyHash === keyHash ? 'current' : 'previous';

    // 6. La IP, antes que cualquier estado (no se cuenta como fallo).
    if (conn.ipAllowlist.length > 0 && !(ipInList(ip, conn.ipAllowlist) && ipInList(ip, conn.partner.egressIps))) {
      await this.foreign.record(conn, ip).catch((err: unknown) => this.logger.warn(`IP ajena sin apuntar: ${(err as Error).message}`));
      throw partnerError('ip_not_allowed');
    }

    // 7. El estado.
    await this.assertUsable(conn, keyMatch, now);

    // 8. El local de la clave, estricto.
    bindTenantContext(this.cls, { tenantId: conn.tenantId, partnerConnectionId: conn.id, strictTenancy: true });

    // 9. Permisos: los de la clave dentro del techo del socio, leído ahora. La pausa, solo en las rutas
    // cuya respuesta 403 declara scope_paused (las de leer, listar o anular no la miran).
    const ceiling = new Set(conn.partner.allowedScopes);
    const effectiveScopes = PARTNER_SCOPES.filter((s) => conn.scopes.includes(s) && ceiling.has(s));
    if (!def.scopes.includes('any')) {
      const usable = def.scopes.filter((s): s is PartnerScope => s !== 'any' && effectiveScopes.includes(s));
      if (usable.length === 0) throw partnerError('scope_missing', { required_scope: def.scopes[0] as PartnerScope });
      if (routeCodes(def).has('scope_paused') && usable.every((s) => conn.pausedScopes.includes(s))) throw partnerError('scope_paused');
    }
    return { conn, keyMatch, effectiveScopes };
  }

  private async assertUsable(conn: PartnerGuardConnection, keyMatch: 'current' | 'previous', now: Date): Promise<void> {
    const venue = conn.venue;
    if (conn.status === 'REVOKED' || venue.deletedAt) throw partnerError('api_key_revoked');
    const expiresAt = keyMatch === 'previous' ? conn.prevKeyExpiresAt : conn.keyExpiresAt;
    if (expiresAt && expiresAt.getTime() <= now.getTime()) throw partnerError('api_key_expired');
    if (conn.keySuspendedAt) throw partnerError('api_key_suspended');
    if (now.getTime() - latest(conn.keyCreatedAt, conn.lastUsedAt, conn.keyResumedAt) > DORMANT_AFTER_MS) {
      await this.suspend(conn, now);
      throw partnerError('api_key_suspended');
    }
    if (conn.partner.status === 'SUSPENDED') throw partnerError('partner_suspended');
    // El contrato: un local sin sociedad, en otra que al conectar o con su sociedad sin NIF pausa la conexión
    // en todas las rutas (sin emisor no hay respuesta), sin tocar la fila: vuelve cuando OxioPay lo arregla.
    if (conn.status === 'PAUSED' || !venue.businessId || venue.businessId !== conn.businessId || !venue.business?.taxId) {
      throw partnerError('connection_paused');
    }
  }

  /** La primera vez que se ve dormida: queda en la base y en el registro (sin aviso). */
  private async suspend(conn: PartnerGuardConnection, now: Date): Promise<void> {
    await this.prisma.asSystem(async (tx) => {
      const marked = await tx.partnerConnection.updateMany({
        where: { id: conn.id, tenantId: conn.tenantId, keySuspendedAt: null },
        data: { keySuspendedAt: now },
      });
      if (marked.count === 0) return;
      await this.audit.logInTx(tx, {
        action: PARTNER_AUDIT.keySuspended,
        tenantId: conn.tenantId,
        targetType: 'PartnerConnection',
        targetId: conn.id,
        payload: partnerAuditPayload(conn),
      });
    });
  }

  /** Un fallo de verdad: cuenta (por clave, por IP y en el cortacircuitos) y se responde. */
  private async failure(keyHash: string, ip: string | null, code: 'invalid_api_key' | 'wrong_environment'): Promise<PartnerHttpException> {
    await this.redis(() => this.limiter.recordFailure(keyHash, ip));
    return partnerError(code);
  }

  /** Redis cerrado ante fallos: 503 try_later. */
  private async redis<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this.logger.warn(`API de socios: Redis no responde (${(err as Error).message}): 503`);
      throw partnerError('try_later', {}, REDIS_DOWN_RETRY_S);
    }
  }
}
