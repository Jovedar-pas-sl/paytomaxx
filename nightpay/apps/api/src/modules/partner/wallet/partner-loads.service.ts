import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@nightpay/db';
import type { ZodTypeAny } from 'zod';
import {
  CASH_TOP_UP_METHODS,
  LOAD_DEADLINE_MS,
  LOAD_PANEL_VOID_WINDOW_MS,
  LOAD_TX,
  LOAD_VOID_WINDOW_MS,
  METHOD_DISABLED_DETAIL,
  PARTNER_TERMS,
  WalletLoadRequest,
  WalletLoadVoidRequest,
  disabledMethod,
  loadLimitDetail,
  parseOperationsQuery,
  parseStatementQuery,
  parsePublicId,
  paymentMethodsOf,
  publicId,
  rangeTooLongDetail,
  stepUpActions,
  type JwtPayload,
  type PartnerLoadAdminView,
  type PartnerOwnerStatement,
  type PartnerLoadVoidDto,
  type PartnerLoadsPage,
  type PartnerQueryFault,
  type StatementBody,
  type WalletLoadBody,
  type WalletLoadListBody,
  type WalletLoadRequestBody,
} from '@nightpay/contracts';
import { isDatabaseBusy } from '../../../common/filters/problem-details.filter';
import { ZodValidationPipe } from '../../../common/pipes/zod.pipe';
import { PrismaService, type TransactionalClient } from '../../../common/prisma/prisma.service';
import { lastNightCutoff, madridDay } from '../../../common/time/madrid';
import { eur } from '../../../common/money/eur';
import { AuditService } from '../../audit/audit.service';
import { TotpService } from '../../auth/totp.service';
import { LEGAL_UPDATED } from '../../legal/legal-owner';
import { VENUE_PAUSE_SELECT, venuePauseScope } from '../../venues/venue-pause';
import { ChargeAlertService } from '../../wallets/charge-alert/charge-alert.service';
import { reopenData } from '../../wallets/wallet-activation';
import { walletCash } from '../../wallets/wallet-cash-limits';
import { lockLiveWallet, mergedWalletIds, type LockedWallet } from '../../wallets/wallet-merge-chain';
import { assertTwoFactorCode } from '../../wallets/wallet-two-factor';
import type { PartnerAuth } from '../auth/current-connection.decorator';
import { partnerTermsUrl } from '../connection-view';
import { adminError } from '../connections/partner-rules';
import { partnerError, PartnerHttpException } from '../http/partner-problem';
import {
  assertLoadTexts,
  decodeLoadsCursor,
  encodeLoadsCursor,
  loadRefusal,
  idempotencyKeyOf,
  loadRequestHash,
  loadView,
  nightOf,
  unnamedWallet,
  voidReasonOf,
  voidUntil,
} from './partner-load-rules';
import { PARTNER_LOAD_AUDIT, PartnerLoadWatch, type LoadRefused } from './partner-load-watch';
import { listLoads, loadById, loadByKey, loadWindowTotals, lockLoad, partnerDeviceTotalsSql, partnerStatementSql, type LoadRow } from './partner-loads.sql';
import { PartnerWalletLimits } from './partner-wallet-limits';
import { PartnerWalletRefs, type DeferredAudit } from './partner-wallet-ref';

/** El texto de la fila de caja de una anulación sin motivo (la plataforma, por la API). */
export const PARTNER_VOID_DEFAULT_REASON = 'Anulada por la plataforma';
/** Errores de Postgres que dicen «ocupado»: candado que no llega, sentencia cortada o interbloqueo. */
const BUSY_PG_CODES = new Set(['55P03', '57014', '40P01']);
const TRY_LATER_S = 5;

/** Pasados los 25 s desde que llegó la petición: no se guarda (503 try_later). */
class LoadDeadlineError extends Error {
  constructor() {
    super('La carga no se guarda: pasaron 25 s desde que llegó');
    this.name = 'LoadDeadlineError';
  }
}

/** ¿Un fallo de «ahora no se puede» de la base? (antes de que acabe la función de la transacción). */
export function isLoadBusy(err: unknown): boolean {
  if (err instanceof LoadDeadlineError || isDatabaseBusy(err)) return true;
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2034') return true;
    const pg = (err.meta as { code?: unknown } | undefined)?.code;
    return err.code === 'P2010' && typeof pg === 'string' && BUSY_PG_CODES.has(pg);
  }
  if (err instanceof Prisma.PrismaClientUnknownRequestError) return /\b(55P03|57014|40P01)\b/.test(err.message);
  return false;
}

interface ConnectionRow {
  id: string;
  tenantId: string;
  businessId: string;
  status: string;
  collectionModel: string;
  scopes: string[];
  pausedScopes: string[];
  keyHash: string;
  prevKeyHash: string | null;
  prevKeyExpiresAt: Date | null;
  keyExpiresAt: Date | null;
  keySuspendedAt: Date | null;
  loadPerOpMaxCents: number;
  loadWalletDayMaxCents: number;
  loadNightMaxCents: number;
  partner: { id: string; name: string; status: string; allowedScopes: string[] };
  venue: { deletedAt: Date | null; businessId: string | null; business: { taxId: string | null } | null };
}

type CreateOutcome =
  | { kind: 'replay'; body: WalletLoadBody }
  | { kind: 'created'; body: WalletLoadBody; walletId: string; nightTotalCents: number; nightCapCents: number; now: Date };

type VoidActor = { kind: 'partner'; reason: string | null } | { kind: 'venue'; userId: string; reason: string };

/**
 * Las cargas de saldo de los socios (PR 3, A4–A7): cargar, leer, listar, el
 * resumen y anular (por la API en 10 minutos; desde el panel, el dueño o el
 * encargado, en 36 h con 2FA). El efectivo es del local (VENUE_COLLECTS): cada
 * carga es una fila de wallet_cash_topups (así el tope legal, el IVA y el %
 * de plataforma ya la ven) más su LOAD del libro, con el saldo y la conexión
 * bloqueados, y su registro; todo o nada. Nunca al log el `qr`, el UID, la
 * descripción ni el motivo.
 */
@Injectable()
export class PartnerLoadsService {
  private readonly logger = new Logger(PartnerLoadsService.name);
  private readonly termsUrl: string;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PartnerWalletRefs) private readonly refs: PartnerWalletRefs,
    @Inject(PartnerWalletLimits) private readonly limits: PartnerWalletLimits,
    @Inject(PartnerLoadWatch) private readonly watch: PartnerLoadWatch,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ChargeAlertService) private readonly alerts: ChargeAlertService,
    @Inject(TotpService) private readonly totp: TotpService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.termsUrl = partnerTermsUrl(config.get<string>('NEXT_PUBLIC_API_URL'));
  }

  // ─── A4. Crear ──────────────────────────────────────────────────────────

  async create(
    auth: PartnerAuth,
    headers: Readonly<Record<string, string | string[] | undefined>>,
    raw: unknown,
    receivedAt: number,
  ): Promise<{ body: WalletLoadBody; replayed: boolean }> {
    // 1. Fuera de la transacción, solo la clave y el esquema.
    const key = idempotencyKeyOf(headers);
    const body = parseBody<WalletLoadRequestBody>(WalletLoadRequest, raw);
    const hash = loadRequestHash(body);
    const conn = auth.connection;
    const audits: DeferredAudit[] = [];
    const state: { refused: LoadRefused | null } = { refused: null };
    let outcome: CreateOutcome;
    try {
      outcome = await this.inLoadTx(receivedAt, async (tx) => {
        // 2. Una petición por clave a la vez (la segunda espera, como mucho lock_timeout).
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`partner-load:${conn.id}:${key}`}, 0))`;
        // 3. Con esa clave: la misma petición, su respuesta; otra, 422 con la carga que la tiene.
        const existing = await loadByKey(tx, { tenantId: conn.tenantId, connectionId: conn.id, idempotencyKey: key });
        if (existing) {
          if (existing.requestHash === hash) return { kind: 'replay', body: existing.response as WalletLoadBody };
          throw partnerError('idempotency_key_reused', {
            operation: {
              object: 'wallet_load',
              id: publicId('wl', existing.id),
              status: existing.voidedAt ? 'voided' : 'succeeded',
              amount: existing.amountCents,
              created_at: existing.createdAt.toISOString(),
            },
          });
        }
        const description = assertLoadTexts(body);
        // 4. El local: en pausa, 423; «Saldo» o «Recarga en efectivo» apagados, 409.
        await assertVenueTakesLoads(tx, conn.tenantId);
        // 5. El saldo: alcance antes de nada; luego bloqueado y comprobado.
        const { wallet, refKind } = await this.refs.resolveLocked(auth, body, tx, audits);
        // 6. 6 cargas por saldo y minuto (sin Redis, 503).
        await this.limits.loadsPerWallet(auth, wallet.id);
        // 7. El teléfono del saldo y la conexión bloqueada (saldo → conexión), otra vez comprobada.
        const phone = await tx.$queryRaw<Array<{ contactPhone: string | null }>>`
          SELECT "contactPhone" FROM client_wallets WHERE id = ${wallet.id}::uuid`;
        const row = await lockConnection(tx, conn.tenantId, conn.id);
        const now = new Date();
        recheckConnection(row, auth, now);
        // 8. Los topes, en la base y bajo los candados, en el orden del contrato; el efectivo, el último.
        const caps = { perOperationCents: row.loadPerOpMaxCents, walletDayCents: row.loadWalletDayMaxCents, nightCents: row.loadNightMaxCents };
        const walletIds = await mergedWalletIds(tx, wallet.id);
        const totals = await loadWindowTotals(tx, {
          connectionId: conn.id,
          partnerId: row.partner.id,
          walletIds,
          now,
          nightStart: lastNightCutoff(now),
        });
        const hit = loadRefusal(body.amount, caps, totals, unnamedWallet(phone[0]?.contactPhone), await walletCash(tx, wallet.id, now));
        if (hit) {
          state.refused = { walletId: wallet.id, limit: hit.limit, amountCents: body.amount, idempotencyKey: key, requestHash: hash, now };
          if (hit.limit === 'cash') throw partnerError('cash_limit_reached');
          throw partnerError(
            'limit_exceeded',
            { limit: hit.limit, ...(hit.remaining === null ? {} : { remaining: hit.remaining }) },
            undefined,
            loadLimitDetail(hit.limit, caps.perOperationCents),
          );
        }
        // 9. El saldo, la fila de caja, la LOAD y su registro, con la misma hora: la de escribir, no la de
        // los topes (un cierre de noche que lee entre medias la deja en el Z siguiente, nunca en ninguno).
        const loaded = await this.credit(tx, auth, { wallet, body, description, refKind, key, hash });
        return {
          kind: 'created',
          body: loaded.body,
          walletId: wallet.id,
          nightTotalCents: totals.connectionNight + body.amount,
          nightCapCents: caps.nightCents,
          now: loaded.at,
        };
      });
    } catch (err) {
      await this.flush(audits);
      const refused = state.refused;
      if (refused && err instanceof PartnerHttpException) this.afterResponse(() => this.watch.refused(auth, refused));
      throw err;
    }
    await this.flush(audits);
    if (outcome.kind === 'created') {
      const done = outcome;
      this.afterResponse(() =>
        this.watch.loaded(auth, {
          walletId: done.walletId,
          amountCents: body.amount,
          device: body.device ?? null,
          nightTotalCents: done.nightTotalCents,
          nightCapCents: done.nightCapCents,
          now: done.now,
        }),
      );
    }
    return { body: outcome.body, replayed: outcome.kind === 'replay' };
  }

  /** Con el saldo y la conexión bloqueados y los topes mirados: suma, apunta la caja y la LOAD, y registra. */
  private async credit(
    tx: TransactionalClient,
    auth: PartnerAuth,
    a: { wallet: LockedWallet; body: WalletLoadRequestBody; description: string; refKind: string; key: string; hash: string },
  ): Promise<{ body: WalletLoadBody; at: Date }> {
    const conn = auth.connection;
    const opId = randomUUID();
    const amount = a.body.amount;
    const reopen = await reopenData(tx, a.wallet);
    // La hora de la carga, lo más tarde posible: justo antes de escribir.
    const now = new Date();
    await tx.clientWallet.update({
      where: { id: a.wallet.id },
      // Una carga: el cliente se queda (un «Me voy» pendiente ya no vale).
      data: { balanceCents: { increment: amount }, closeRequestedAt: null, ...reopen },
    });
    const balanceAfter = a.wallet.balanceCents + amount;
    const cash = await tx.walletCashTopUp.create({
      data: {
        tenantId: conn.tenantId,
        walletId: a.wallet.id,
        amountCents: amount,
        partnerConnectionId: conn.id,
        idempotencyKey: `partner:${opId}`,
        createdWallet: false,
        createdAt: now,
      },
      select: { id: true },
    });
    const response: WalletLoadBody = {
      object: 'wallet_load',
      id: publicId('wl', opId),
      status: 'succeeded',
      amount,
      currency: 'EUR',
      description: a.description,
      reference: a.body.reference ?? null,
      funding: a.body.funding,
      device: a.body.device ?? null,
      created_at: now.toISOString(),
      void_until: voidUntil(now).toISOString(),
      ...(auth.effectiveScopes.includes('wallet:balance') ? { balance_after: balanceAfter } : {}),
      terms: { url: this.termsUrl, version: LEGAL_UPDATED, ...PARTNER_TERMS },
      livemode: conn.keyMode === 'live',
    };
    await tx.partnerWalletOperation.create({
      data: {
        id: opId,
        tenantId: conn.tenantId,
        connectionId: conn.id,
        kind: 'LOAD',
        walletId: a.wallet.id,
        amountCents: amount,
        balanceBeforeCents: a.wallet.balanceCents,
        balanceAfterCents: balanceAfter,
        description: a.description,
        reference: a.body.reference ?? null,
        device: a.body.device ?? null,
        funding: a.body.funding,
        cashTopupId: cash.id,
        refKind: a.refKind,
        idempotencyKey: a.key,
        requestHash: a.hash,
        response: response as unknown as Prisma.InputJsonValue,
        createdAt: now,
      },
    });
    await this.audit.logInTx(tx, {
      action: PARTNER_LOAD_AUDIT.loaded,
      tenantId: conn.tenantId,
      targetType: 'PartnerConnection',
      targetId: conn.id,
      // Nunca el `qr`, el UID ni la descripción.
      payload: {
        connectionId: conn.id,
        keyHint: auth.keyHint,
        name: conn.partner.name,
        loadId: response.id,
        walletId: a.wallet.id,
        amountCents: amount,
        funding: a.body.funding,
        device: a.body.device ?? null,
        refKind: a.refKind,
      },
    });
    return { body: response, at: now };
  }

  // ─── A5. Leer, listar y el resumen ──────────────────────────────────────

  async get(auth: PartnerAuth, id: string): Promise<WalletLoadBody> {
    const conn = auth.connection;
    const uuid = parsePublicId('wl', id);
    if (!uuid) throw partnerError('load_not_found');
    const row = await this.prisma.withTenant(conn.tenantId, (tx) => loadById(tx, { tenantId: conn.tenantId, connectionId: conn.id, id: uuid }));
    if (!row) throw partnerError('load_not_found');
    return loadView(row, withBalance(auth));
  }

  async list(auth: PartnerAuth, query: Readonly<Record<string, unknown>>): Promise<WalletLoadListBody> {
    const conn = auth.connection;
    const q = parseOperationsQuery(query, nightOf);
    if (!q.ok) throw queryError(q);
    const filters = { from: q.from, to: q.to, reference: q.reference };
    const after = q.cursor === null ? null : decodeLoadsCursor(q.cursor, filters);
    const rows = await this.prisma.withTenant(conn.tenantId, (tx) =>
      listLoads(tx, { tenantId: conn.tenantId, connectionId: conn.id, ...filters, after, take: q.limit + 1 }),
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const hasMore = rows.length > q.limit;
    return {
      object: 'list',
      data: page.map((r) => loadView(r, withBalance(auth))),
      has_more: hasMore,
      next_cursor: hasMore && last ? encodeLoadsCursor(last, filters) : null,
    };
  }

  async statement(auth: PartnerAuth, query: Readonly<Record<string, unknown>>): Promise<StatementBody> {
    const q = parseStatementQuery(query);
    if (!q.ok) throw queryError(q);
    return this.statementOf(auth.connection.tenantId, auth.connection.id, q.from, q.to, auth.connection.keyMode === 'live');
  }

  private async statementOf(tenantId: string, connectionId: string, from: Date, to: Date, livemode: boolean): Promise<StatementBody> {
    const t = await this.prisma.withTenant(tenantId, (tx) => partnerStatementSql(tx, { tenantId, connectionId, from, to }));
    const funding = t.byFunding;
    const loads = Object.values(funding).reduce((acc, f) => ({ count: acc.count + f.count, amount: acc.amount + f.amount }), { count: 0, amount: 0 });
    return {
      object: 'statement',
      from: from.toISOString(),
      to: to.toISOString(),
      currency: 'EUR',
      livemode,
      loads: { ...loads, by_funding: funding },
      load_voids: t.voids,
      net_loads: loads.amount - t.voids.amount,
    };
  }

  // ─── A6. Anular ─────────────────────────────────────────────────────────

  /** `POST /wallet/loads/{id}/void`: solo las suyas, en 10 minutos, si el saldo la cubre. */
  async voidByPartner(auth: PartnerAuth, id: string, raw: unknown, receivedAt: number): Promise<WalletLoadBody> {
    const conn = auth.connection;
    const body = parseBody<{ reason?: string } | undefined>(WalletLoadVoidRequest.optional(), raw) ?? {};
    const reason = voidReasonOf(body.reason);
    const uuid = parsePublicId('wl', id);
    if (!uuid) throw partnerError('load_not_found');
    const result = await this.inLoadTx(receivedAt, async (tx) => {
      const load = await lockLoad(tx, { tenantId: conn.tenantId, connectionId: conn.id, id: uuid });
      if (!load) throw partnerError('load_not_found');
      if (load.voidedAt) return { load, fresh: false as const };
      const now = new Date();
      if (now.getTime() - load.createdAt.getTime() > LOAD_VOID_WINDOW_MS) throw partnerError('void_window_passed');
      const done = await this.voidLoad(tx, conn, load, { kind: 'partner', reason }, now);
      if ('spentBalance' in done) {
        const available = withBalance(auth) && (await this.refs.isReachable(tx, auth, done.wallet)) ? done.spentBalance : undefined;
        throw partnerError('balance_already_spent', available === undefined ? {} : { available });
      }
      await this.audit.logInTx(tx, {
        action: PARTNER_LOAD_AUDIT.voided,
        tenantId: conn.tenantId,
        targetType: 'PartnerConnection',
        targetId: conn.id,
        payload: { connectionId: conn.id, keyHint: auth.keyHint, name: conn.partner.name, loadId: publicId('wl', load.id), amountCents: load.amountCents, hasReason: reason !== null },
      });
      return { load: { ...load, voidedAt: now }, fresh: true as const, walletId: done.walletId, now };
    });
    if (result.fresh) {
      this.alerts.loadVoided({ walletId: result.walletId, loadId: result.load.id, partnerName: conn.partner.name, amountCents: result.load.amountCents });
      const now = result.now;
      this.afterResponse(() => this.watch.apiVoided(auth, now));
    }
    return loadView(result.load, withBalance(auth));
  }

  /** Desde el panel (OWNER y MANAGER): 2FA atada a la carga, hasta 36 h, si el saldo la cubre. */
  async voidByVenue(user: JwtPayload, connectionId: string, loadId: string, dto: PartnerLoadVoidDto): Promise<PartnerLoadAdminView> {
    await assertTwoFactorCode(this.totp, user.sub, dto.totpCode, 'Anular la carga de una plataforma:', stepUpActions.partner('void', loadId));
    const reason = dto.reason.trim();
    const conn = await this.ownConnection(user, connectionId);
    const result = await this.inLoadTx(
      Date.now(),
      async (tx) => {
        const load = await lockLoad(tx, { tenantId: user.tenantId, connectionId: conn.id, id: loadId });
        if (!load) throw adminError('PARTNER_LOAD_NOT_FOUND');
        if (load.voidedAt) throw adminError('PARTNER_LOAD_ALREADY_VOIDED');
        const now = new Date();
        if (now.getTime() - load.createdAt.getTime() > LOAD_PANEL_VOID_WINDOW_MS) throw adminError('PARTNER_LOAD_TOO_OLD');
        const done = await this.voidLoad(tx, conn, load, { kind: 'venue', userId: user.sub, reason }, now);
        if ('spentBalance' in done) {
          throw adminError('PARTNER_LOAD_SPENT', `El saldo ya no cubre la carga (le quedan ${eur(done.spentBalance)}): ya se ha gastado. No se puede anular.`);
        }
        await this.audit.logInTx(tx, {
          action: PARTNER_LOAD_AUDIT.voidedByVenue,
          tenantId: user.tenantId,
          actorId: user.sub,
          actorEmail: user.email ?? null,
          targetType: 'PartnerConnection',
          targetId: conn.id,
          // El motivo, solo en sus columnas y el panel.
          payload: { connectionId: conn.id, name: conn.partner.name, loadId: publicId('wl', load.id), amountCents: load.amountCents, hasReason: true },
        });
        return { load: { ...load, voidedAt: now, voidedByUserId: user.sub, voidReason: reason }, walletId: done.walletId };
      },
      () => new HttpException({ code: 'TRY_LATER', message: 'Ahora no se puede: inténtalo en unos segundos.' }, 503),
    );
    this.alerts.loadVoided({ walletId: result.walletId, loadId: result.load.id, partnerName: conn.partner.name, amountCents: result.load.amountCents });
    const [view] = await this.adminViews([result.load]);
    return view!;
  }

  /**
   * Lo único que resta saldo en la API de socios: con la carga bloqueada, el
   * saldo vivo bloqueado y, si aún la cubre, el saldo baja (DEPLETED a 0), la
   * fila negativa de caja y la LOAD_VOID, con el `now` de la anulación. Los
   * bloqueos y la pausa del local no la paran.
   */
  private async voidLoad(
    tx: TransactionalClient,
    conn: { id: string; tenantId: string },
    load: LoadRow,
    by: VoidActor,
    now: Date,
  ): Promise<{ walletId: string } | { spentBalance: number; wallet: LockedWallet }> {
    const wallet = await lockLiveWallet(tx, load.walletId);
    if (!wallet) throw new Error('El saldo de una carga no existe');
    if (wallet.balanceCents < load.amountCents) return { spentBalance: wallet.balanceCents, wallet };
    const left = wallet.balanceCents - load.amountCents;
    await tx.clientWallet.update({
      where: { id: wallet.id },
      data: { balanceCents: left, ...(left === 0 ? { status: 'DEPLETED' as const } : {}) },
    });
    let cashVoidId: string | null = null;
    if (load.cashTopupId) {
      const cashVoid = await tx.walletCashTopUp.create({
        data: {
          tenantId: conn.tenantId,
          walletId: load.walletId,
          amountCents: -load.amountCents,
          partnerConnectionId: conn.id,
          takenByUserId: by.kind === 'venue' ? by.userId : null,
          idempotencyKey: `void:${load.cashTopupId}`,
          voidOfId: load.cashTopupId,
          reason: by.reason ?? PARTNER_VOID_DEFAULT_REASON,
          createdWallet: false,
          createdAt: now,
        },
        select: { id: true },
      });
      cashVoidId = cashVoid.id;
    }
    await tx.partnerWalletOperation.create({
      data: {
        tenantId: conn.tenantId,
        connectionId: conn.id,
        kind: 'LOAD_VOID',
        reversesId: load.id,
        walletId: wallet.id,
        amountCents: load.amountCents,
        balanceBeforeCents: wallet.balanceCents,
        balanceAfterCents: left,
        cashTopupId: cashVoidId,
        reason: by.reason,
        voidedByUserId: by.kind === 'venue' ? by.userId : null,
        idempotencyKey: `void:${load.id}`,
        createdAt: now,
      },
    });
    return { walletId: wallet.id };
  }

  // ─── A7. Del dueño: las cargas y el resumen de una conexión ────────────

  async ownerLoads(user: JwtPayload, connectionId: string, query: Readonly<Record<string, unknown>>): Promise<PartnerLoadsPage> {
    const conn = await this.ownConnection(user, connectionId);
    const q = parseOperationsQuery(
      { business_date: query.business_date ?? madridDay(lastNightCutoff(new Date())), reference: query.reference, cursor: query.cursor, limit: query.limit },
      nightOf,
    );
    if (!q.ok) throw ownerQueryError(q);
    const filters = { from: q.from, to: q.to, reference: q.reference };
    let after: { createdAt: Date; id: string } | null = null;
    try {
      after = q.cursor === null ? null : decodeLoadsCursor(q.cursor, filters);
    } catch {
      throw ownerQueryError({ ok: false, code: 'validation_failed', param: 'cursor' });
    }
    const rows = await this.prisma.withTenant(user.tenantId, (tx) =>
      listLoads(tx, { tenantId: user.tenantId, connectionId: conn.id, ...filters, after, take: q.limit + 1 }),
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      loads: await this.adminViews(page),
      nextCursor: rows.length > q.limit && last ? encodeLoadsCursor(last, filters) : null,
    };
  }

  /** El `/statement` del socio (sin cambiar) más `byDevice`, que solo ve el dueño («Movimientos» por cajero). */
  async ownerStatement(user: JwtPayload, connectionId: string, query: Readonly<Record<string, unknown>>): Promise<PartnerOwnerStatement> {
    const conn = await this.ownConnection(user, connectionId);
    const q = parseOperationsQuery({ business_date: query.business_date ?? madridDay(lastNightCutoff(new Date())) }, nightOf);
    if (!q.ok) throw ownerQueryError(q);
    const [statement, byDevice] = await Promise.all([
      this.statementOf(user.tenantId, conn.id, q.from, q.to, conn.keyMode === 'live'),
      this.prisma.withTenant(user.tenantId, (tx) =>
        partnerDeviceTotalsSql(tx, { tenantId: user.tenantId, connectionId: conn.id, from: q.from, to: q.to }),
      ),
    ]);
    return { ...statement, byDevice };
  }

  /** La vista del dueño; la pista del saldo, de otra lectura en asSystem (como CashTopUpService.recent()). */
  private async adminViews(rows: LoadRow[]): Promise<PartnerLoadAdminView[]> {
    const codes = await this.prisma.asSystem((tx) =>
      tx.clientWallet.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.walletId))] } }, select: { id: true, shortCode: true } }),
    );
    const codeOf = new Map(codes.map((c) => [c.id, c.shortCode]));
    return rows.map((r) => ({
      id: r.id,
      publicId: publicId('wl', r.id),
      status: r.voidedAt ? 'voided' : 'succeeded',
      amountCents: r.amountCents,
      description: r.description,
      reference: r.reference,
      funding: r.funding as PartnerLoadAdminView['funding'],
      device: r.device,
      createdAt: r.createdAt.toISOString(),
      voidUntil: voidUntil(r.createdAt).toISOString(),
      voidedAt: r.voidedAt?.toISOString() ?? null,
      voidedBy: r.voidedAt ? (r.voidedByUserId ? 'venue' : 'partner') : null,
      reason: r.voidReason,
      balanceAfterCents: r.balanceAfterCents,
      codeHint: `${(codeOf.get(r.walletId) ?? '').slice(0, 3)}-•••`,
    }));
  }

  /** La conexión del local del JWT; la de otro local, como si no existiera. */
  private async ownConnection(user: JwtPayload, id: string): Promise<{ id: string; tenantId: string; keyMode: string; partner: { name: string } }> {
    const conn = await this.prisma.withTenant(user.tenantId, (tx) =>
      tx.partnerConnection.findFirst({
        where: { id, tenantId: user.tenantId },
        select: { id: true, tenantId: true, keyMode: true, partner: { select: { name: true } } },
      }),
    );
    if (!conn) throw adminError('PARTNER_CONNECTION_NOT_FOUND');
    return conn;
  }

  // ─── La transacción del dinero ──────────────────────────────────────────

  /**
   * asSystem con el local de la conexión en el contexto, candados de 10 s y
   * el corte de 25 s desde que llegó (la última sentencia de la función). Solo
   * es 503 try_later lo que falla antes de que la función acabe; un fallo al
   * confirmar es 500 internal_error (puede estar guardada: el reintento la repite).
   */
  private async inLoadTx<T>(receivedAt: number, fn: (tx: TransactionalClient) => Promise<T>, busy?: () => Error): Promise<T> {
    let finished = false;
    try {
      return await this.prisma.asSystem(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '10s'`);
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '10s'`);
        const out = await fn(tx);
        if (Date.now() - receivedAt > LOAD_DEADLINE_MS) throw new LoadDeadlineError();
        finished = true;
        return out;
      }, LOAD_TX);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (!finished && isLoadBusy(err)) {
        this.logger.warn(`API de socios: carga o anulación sin hacer, la base está ocupada (${(err as Error).name}): 503`);
        throw busy ? busy() : partnerError('try_later', {}, TRY_LATER_S);
      }
      if (finished) {
        this.logger.error(`API de socios: fallo al confirmar una carga o anulación (${(err as Error).name}): puede estar guardada`);
        throw busy ? err : partnerError('internal_error');
      }
      throw err;
    }
  }

  /** Los registros de la resolución, tras la transacción (también si se deshizo). */
  private async flush(audits: DeferredAudit[]): Promise<void> {
    for (const write of audits.splice(0)) {
      await write().catch((err: unknown) => this.logger.warn(`API de socios: registro de una carga sin escribir (${(err as Error).name})`));
    }
  }

  /** Lo que se hace tras responder (la vigilancia): nunca cambia ni retrasa la respuesta. */
  private afterResponse(fn: () => Promise<void>): void {
    setImmediate(() => {
      fn().catch((err: unknown) => this.logger.warn(`API de socios: vigilancia de cargas sin hacer (${(err as Error).name})`));
    });
  }
}

// ─── Ayudantes ────────────────────────────────────────────────────────────

/** El cuerpo con su esquema (los mismos 400/422 que el ZodValidationPipe). */
function parseBody<T>(schema: ZodTypeAny, raw: unknown): T {
  return new ZodValidationPipe(schema).transform(raw) as T;
}

const withBalance = (auth: PartnerAuth) => auth.effectiveScopes.includes('wallet:balance');

/** La pausa del local (423) y sus interruptores: «Saldo» y «Recarga en efectivo» (409 method_disabled). */
async function assertVenueTakesLoads(tx: TransactionalClient, venueId: string): Promise<void> {
  const venue = await tx.venue.findUnique({ where: { id: venueId }, select: { ...VENUE_PAUSE_SELECT, paymentMethods: true } });
  if (venuePauseScope(venue)) throw partnerError('venue_paused');
  const off = disabledMethod(paymentMethodsOf(venue?.paymentMethods), CASH_TOP_UP_METHODS);
  if (off) {
    const method = off === 'wallet' ? 'wallet' : 'cash_top_up';
    throw partnerError('method_disabled', { method, reason: 'venue_setting' }, undefined, METHOD_DISABLED_DETAIL[method]);
  }
}

async function lockConnection(tx: TransactionalClient, tenantId: string, id: string): Promise<ConnectionRow> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id::text AS id FROM partner_connections WHERE id = ${id}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
  const row = locked.length
    ? await tx.partnerConnection.findFirst({
        where: { id, tenantId },
        include: {
          partner: { select: { id: true, name: true, status: true, allowedScopes: true } },
          venue: { select: { deletedAt: true, businessId: true, business: { select: { taxId: true } } } },
        },
      })
    : null;
  // Borrada entre el guard y aquí (el local se borró): como una clave anulada.
  if (!row) throw partnerError('api_key_revoked');
  return row;
}

/**
 * Con la conexión bloqueada, otra vez los pasos 7 y 9 del guard: lo que pudo
 * cambiar desde que entró (anulada, rotada, caducada, dormida, socio
 * suspendido, pausa, sociedad, permisos y su pausa) y el modelo de cobro.
 */
export function recheckConnection(row: ConnectionRow, auth: PartnerAuth, now: Date): void {
  if (row.status === 'REVOKED' || row.venue.deletedAt) throw partnerError('api_key_revoked');
  const current = row.keyHash === auth.keyHash;
  const previous = row.prevKeyHash === auth.keyHash && row.prevKeyExpiresAt !== null && row.prevKeyExpiresAt.getTime() > now.getTime();
  if (!current && !previous) throw partnerError('api_key_rotated');
  const expiresAt = current ? row.keyExpiresAt : row.prevKeyExpiresAt;
  if (expiresAt && expiresAt.getTime() <= now.getTime()) throw partnerError('api_key_expired');
  if (row.keySuspendedAt) throw partnerError('api_key_suspended');
  if (row.partner.status === 'SUSPENDED') throw partnerError('partner_suspended');
  if (row.status === 'PAUSED' || !row.venue.businessId || row.venue.businessId !== row.businessId || !row.venue.business?.taxId) {
    throw partnerError('connection_paused');
  }
  if (!row.scopes.includes('wallet:load') || !row.partner.allowedScopes.includes('wallet:load')) {
    throw partnerError('scope_missing', { required_scope: 'wallet:load' });
  }
  if (row.pausedScopes.includes('wallet:load')) throw partnerError('scope_paused');
  if (row.collectionModel !== 'VENUE_COLLECTS') throw partnerError('funding_not_allowed');
}

/** Una consulta que no vale, como el contrato (validation_failed con `param`, o range_too_long). */
function queryError(q: PartnerQueryFault): PartnerHttpException {
  if (q.code === 'range_too_long') return partnerError('range_too_long', {}, undefined, rangeTooLongDetail(q.maxDays ?? 31));
  return partnerError('validation_failed', { param: q.param }, undefined, {
    en: `${q.param} breaks its rule.`,
    es: `${q.param}: no cumple su regla.`,
  });
}

function ownerQueryError(q: PartnerQueryFault): HttpException {
  return new HttpException({ code: 'PARTNER_QUERY_INVALID', message: 'Esa búsqueda no vale.', param: q.param ?? null }, 400);
}
