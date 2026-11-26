import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  LIVE_CODE_RE,
  WALLET_REF_DETAIL,
  normalizeWalletCardUid,
  walletCardTokenFromUrl,
  type WalletBalanceRequestBody,
  type WalletRefReason,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../../common/redis/redis.module';
import { AuditService } from '../../audit/audit.service';
import { isIssuedCard } from '../../wallets/wallet-card-ops';
import { WalletLiveCodeService } from '../../wallets/wallet-live-code.service';
import { liveWalletId } from '../../wallets/wallet-merge-chain';
import { formatWalletCode, sameWalletGroup } from '../../wallets/wallet-rules';
import type { PartnerAuth } from '../auth/current-connection.decorator';
import { partnerError } from '../http/partner-problem';
import { PARTNER_WALLET_AUDIT, PartnerWalletLimits, type PartnerRefKind } from './partner-wallet-limits';

// ─── A2. Clasificar el `qr` (solo por su forma) ─────────────────────────

/** Lo que es el `qr` por su forma. El enlace privado lleva su tramo (para el registro, nunca a ningún log). */
export type WalletRefShape =
  | { kind: 'live_code'; code: string }
  | { kind: 'ficha'; token: string }
  | { kind: 'rejected'; reason: Exclude<WalletRefReason, 'private_link'> }
  | { kind: 'rejected'; reason: 'private_link'; privateLink: string }
  | { kind: 'live_code_malformed' }
  | { kind: 'unrecognized' };

const SHORT_CODE = /^[A-Za-z0-9]{3}[- ]?[A-Za-z0-9]{3}$/;
const PRIVATE_LINK = /^[A-Za-z0-9_-]{16,64}$/;
const OTHER_LINK_ROOTS = new Set(['r', 'reservar', 'reservas']);
const UNRECOGNIZED: WalletRefShape = { kind: 'unrecognized' };

function parseUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

function decodeSegments(pathname: string): string[] | null {
  try {
    return pathname.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
}

/**
 * La forma del texto leído (el contrato, `Qr`). Pura y sin lanzar nunca. En
 * orden: el código del móvil; el QR de recepción y el código de 6; solo
 * `https:`; por el primer tramo de la ruta (cobros, pase, enlace privado,
 * otros enlaces); la ficha (cualquier host) y `?saldo=`.
 */
export function classifyWalletRef(raw: string): WalletRefShape {
  const text = raw.trim();
  if (/^oxc1:/i.test(text)) {
    const code = text.toUpperCase();
    return LIVE_CODE_RE.test(code) ? { kind: 'live_code', code } : { kind: 'live_code_malformed' };
  }
  if (text.startsWith('NPF:')) return { kind: 'rejected', reason: 'reception_qr' };
  if (SHORT_CODE.test(text)) return { kind: 'rejected', reason: 'short_code' };
  const url = parseUrl(text);
  if (!url || url.protocol !== 'https:') return UNRECOGNIZED;
  const segments = decodeSegments(url.pathname);
  if (!segments) return UNRECOGNIZED;
  const [first, second] = segments;
  if (first === 's' || first === 'pay') return { kind: 'rejected', reason: 'charge_link' };
  if (first === 'c') return { kind: 'rejected', reason: 'wallet_pass' };
  if (first === 'w') {
    return second !== undefined && PRIVATE_LINK.test(second)
      ? { kind: 'rejected', reason: 'private_link', privateLink: second }
      : { kind: 'rejected', reason: 'other_link' };
  }
  if (first !== undefined && OTHER_LINK_ROOTS.has(first)) return { kind: 'rejected', reason: 'other_link' };
  const token = walletCardTokenFromUrl(text);
  if (token) return { kind: 'ficha', token };
  if (url.searchParams.has('saldo')) return { kind: 'rejected', reason: 'short_code' };
  return UNRECOGNIZED;
}

// ─── El alcance de una clave ─────────────────────────────────────────────

/**
 * ¿Llega esta clave a este saldo? El mismo grupo que comprueba el personal
 * del local (sameWalletGroup) **y** el local de origen del saldo (donde se
 * creó) con sociedad, la misma que la del local de la clave. Pura: la usa
 * también la página del saldo (PR 8).
 */
export function walletReachable(
  wallet: { tenantId: string; walletGroup: string | null },
  home: { businessId: string | null },
  conn: { tenantId: string; walletGroup: string | null; businessId: string | null },
): boolean {
  return (
    sameWalletGroup(wallet, { id: conn.tenantId, walletGroup: conn.walletGroup }) &&
    home.businessId !== null &&
    home.businessId === conn.businessId
  );
}

// ─── A3. Resolver la referencia (con el alcance antes que todo) ─────────

export interface ResolvedWalletRef {
  /** El saldo vivo (donde está hoy el dinero). */
  walletId: string;
  refKind: PartnerRefKind;
  balanceCents: number;
}

/** El `detail` de `nfc_uid` con un código del móvil. */
export const NFC_UID_WITH_LIVE_CODE = {
  en: 'nfc_uid: send it only with a ficha link read by NFC.',
  es: 'nfc_uid: solo va con el enlace de una ficha leída por NFC.',
} as const;

const FIRST_MARK_TTL_S = 86_400;
const REDIS_DOWN_RETRY_S = 5;

interface ScopedWallet {
  id: string;
  balanceCents: number;
  status: string;
  blockedAt: Date | null;
  shortCode: string | null;
}

const WALLET_SELECT = {
  id: true,
  tenantId: true,
  walletGroup: true,
  balanceCents: true,
  status: true,
  blockedAt: true,
  shortCode: true,
} as const;

/**
 * De la referencia que mandó el socio (`qr` y, con una ficha leída por NFC,
 * `nfc_uid`) al saldo vivo, o el error del contrato (solo `partnerError`:
 * un 404 o 409 de Nest saldría como `not_found` o `invalid_request`). Solo
 * lee, en un `asSystem` por petición: ClientWallet, WalletCard y Venue no
 * están en TENANT_SCOPED_MODELS. Nunca va al log el `qr`, el UID ni el
 * enlace. El PR 3 lo reutiliza con candado para las cargas.
 */
@Injectable()
export class PartnerWalletRefs {
  private readonly logger = new Logger(PartnerWalletRefs.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WalletLiveCodeService) private readonly liveCodes: WalletLiveCodeService,
    @Inject(PartnerWalletLimits) private readonly limits: PartnerWalletLimits,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async resolve(auth: PartnerAuth, body: WalletBalanceRequestBody): Promise<ResolvedWalletRef> {
    const shape = classifyWalletRef(body.qr);
    switch (shape.kind) {
      case 'live_code':
        return this.byLiveCode(auth, shape.code, body.nfc_uid);
      case 'ficha':
        return this.byFicha(auth, shape.token, body.nfc_uid);
      case 'rejected':
        await this.limits.scan(auth);
        if (shape.reason === 'private_link') await this.masterLinkSubmitted(auth, shape.privateLink);
        throw partnerError('wallet_ref_not_accepted', { reason: shape.reason }, undefined, WALLET_REF_DETAIL[shape.reason]);
      case 'live_code_malformed':
        await this.limits.scan(auth);
        throw partnerError('live_code_invalid');
      case 'unrecognized':
        await this.limits.scan(auth);
        throw partnerError('wallet_ref_unrecognized');
    }
  }

  /** Un código del móvil: solo el saldo al que se dio (no sigue fusiones) y dentro del alcance. */
  private async byLiveCode(auth: PartnerAuth, code: string, nfcUid: string | undefined): Promise<ResolvedWalletRef> {
    if (nfcUid !== undefined) throw partnerError('validation_failed', { param: 'nfc_uid' }, undefined, NFC_UID_WITH_LIVE_CODE);
    let entry: Awaited<ReturnType<WalletLiveCodeService['peek']>>;
    try {
      entry = await this.liveCodes.peek(code);
    } catch (err) {
      this.logger.warn(`API de socios: no se pueden leer los códigos del móvil (${(err as Error).name}): 503`);
      throw partnerError('try_later', {}, REDIS_DOWN_RETRY_S);
    }
    if (!entry) throw partnerError('live_code_invalid');
    const walletId = entry.walletId;
    const found = await this.prisma.asSystem(async (tx) => {
      if ((await liveWalletId(tx, walletId)) !== walletId) return null;
      return this.scoped(tx, auth, walletId);
    });
    if (!found) throw partnerError('live_code_invalid');
    if (!found.reachable) throw partnerError('wallet_not_found');
    assertWalletUsable(found.wallet);
    return { walletId, refKind: 'live_code', balanceCents: found.wallet.balanceCents };
  }

  /** Una ficha: dada a un saldo, su saldo vivo dentro del alcance; luego su estado, su UID y el saldo. */
  private async byFicha(auth: PartnerAuth, token: string, nfcUid: string | undefined): Promise<ResolvedWalletRef> {
    const found = await this.prisma.asSystem(async (tx) => {
      const card = await tx.walletCard.findUnique({ where: { token }, select: { id: true, status: true, walletId: true, uid: true } });
      if (!card?.walletId) return null;
      if (!isIssuedCard(card) && card.status !== 'LOST' && card.status !== 'BLOCKED') return null;
      const live = await liveWalletId(tx, card.walletId);
      if (!live) return null;
      const scope = await this.scoped(tx, auth, live);
      return scope ? { card, ...scope } : null;
    });
    // Fuera del alcance, el mismo 404 que una ficha desconocida: sin registro, aviso ni contadores.
    if (!found?.reachable) throw partnerError('wallet_not_found');
    const { card, wallet } = found;
    if (card.status === 'LOST') throw partnerError('ficha_lost');
    if (card.status === 'BLOCKED') throw partnerError('ficha_blocked');
    let refKind: PartnerRefKind = 'ficha';
    const stored = card.uid ? normalizeWalletCardUid(card.uid) : null;
    if (nfcUid !== undefined && stored) {
      // El UID que llega nunca se guarda.
      if (normalizeWalletCardUid(nfcUid) !== stored) {
        await this.cardCopySuspected(auth, card.id, wallet);
        throw partnerError('ficha_copy_suspected');
      }
      refKind = 'ficha_nfc';
    }
    assertWalletUsable(wallet);
    return { walletId: wallet.id, refKind, balanceCents: wallet.balanceCents };
  }

  /** El saldo, su local de origen y el de la conexión; null si no existe. */
  private async scoped(tx: TransactionalClient, auth: PartnerAuth, walletId: string): Promise<{ wallet: ScopedWallet; reachable: boolean } | null> {
    const wallet = await tx.clientWallet.findUnique({ where: { id: walletId }, select: WALLET_SELECT });
    if (!wallet) return null;
    return { wallet, reachable: await this.reachable(tx, auth, wallet) };
  }

  private async reachable(tx: TransactionalClient, auth: PartnerAuth, wallet: { tenantId: string; walletGroup: string | null }): Promise<boolean> {
    const [home, own] = await Promise.all([
      tx.venue.findUnique({ where: { id: wallet.tenantId }, select: { businessId: true } }),
      tx.venue.findUnique({ where: { id: auth.connection.tenantId }, select: { walletGroup: true, businessId: true } }),
    ]);
    if (!home || !own) return false;
    return walletReachable(wallet, home, { tenantId: auth.connection.tenantId, walletGroup: own.walletGroup, businessId: own.businessId });
  }

  /**
   * El cliente enseñó el enlace privado de su saldo en otra plataforma: un
   * registro (y su Incidencia) por conexión, saldo y día, solo si el saldo
   * existe, no está sumado a otro y está dentro del alcance. Nunca guarda el
   * enlace: solo 12 hex de su sha256. Si falla, la respuesta no cambia.
   */
  private async masterLinkSubmitted(auth: PartnerAuth, link: string): Promise<void> {
    try {
      const wallet = await this.prisma.asSystem(async (tx) => {
        const w = await tx.clientWallet.findUnique({
          where: { qrToken: link },
          select: { id: true, tenantId: true, walletGroup: true, shortCode: true, mergedIntoId: true },
        });
        if (!w || w.mergedIntoId) return null;
        return (await this.reachable(tx, auth, w)) ? w : null;
      });
      if (!wallet || !(await this.firstToday('master', auth.connection.id, wallet.id))) return;
      await this.audit.log({
        action: PARTNER_WALLET_AUDIT.masterLinkSubmitted,
        tenantId: auth.connection.tenantId,
        targetType: 'ClientWallet',
        targetId: wallet.id,
        payload: {
          connectionId: auth.connection.id,
          keyHint: auth.keyHint,
          name: auth.connection.partner.name,
          ...(wallet.shortCode ? { code: formatWalletCode(wallet.shortCode) } : {}),
          linkRef: createHash('sha256').update(link, 'utf8').digest('hex').slice(0, 12),
        },
      });
    } catch (err) {
      // Solo el tipo: el mensaje de un error de la base podría llevar la consulta.
      this.logger.warn(`API de socios: enlace privado enseñado sin registrar (${(err as Error).name})`);
    }
  }

  /** Una ficha con otro número de serie: un registro (y su Incidencia) por conexión, ficha y día. */
  private async cardCopySuspected(auth: PartnerAuth, cardId: string, wallet: ScopedWallet): Promise<void> {
    if (!(await this.firstToday('copy', auth.connection.id, cardId))) return;
    await this.audit.log({
      action: PARTNER_WALLET_AUDIT.cardCopySuspected,
      tenantId: auth.connection.tenantId,
      targetType: 'ClientWallet',
      targetId: wallet.id,
      payload: {
        cardId,
        connectionId: auth.connection.id,
        keyHint: auth.keyHint,
        name: auth.connection.partner.name,
        ...(wallet.shortCode ? { code: formatWalletCode(wallet.shortCode) } : {}),
      },
    });
  }

  /** La primera vez hoy (SET NX de 24 h); si Redis falla, se registra igual. */
  private async firstToday(kind: 'master' | 'copy', connectionId: string, id: string): Promise<boolean> {
    try {
      return (await this.redis.set(`np:pwref:${kind}:${connectionId}:${id}`, '1', 'EX', FIRST_MARK_TTL_S, 'NX')) === 'OK';
    } catch {
      return true;
    }
  }
}

/** Bloqueado → wallet_blocked; devuelto o caducado → wallet_closed; vacío (DEPLETED) vale. */
function assertWalletUsable(wallet: Pick<ScopedWallet, 'blockedAt' | 'status'>): void {
  if (wallet.blockedAt) throw partnerError('wallet_blocked');
  if (wallet.status === 'REFUNDED' || wallet.status === 'EXPIRED') throw partnerError('wallet_closed');
}
