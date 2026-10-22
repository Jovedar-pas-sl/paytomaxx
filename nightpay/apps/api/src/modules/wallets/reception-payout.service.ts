import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ReceptionPayoutPasskeyRequest,
  ReceptionPayoutPasskeyStatus,
  ReceptionPayoutPlan,
} from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TotpService } from '../auth/totp.service';
import { assertMethodsEnabled } from '../venues/venue-methods';
import {
  assertPayoutInput,
  payoutCardAndWallet,
  payoutVenue,
  receptionCashPayout,
  receptionPayoutPlan,
  type Actor,
  type ReceptionCashInput,
  type ReceptionCashResult,
  type ReceptionDevice,
  type ReceptionPayoutDeps,
} from './reception-cash-payout';
import type { PayoutConfirmView } from './reception-payout-page';
import { ReceptionPayoutPasskeys, payoutPasskeyScope } from './reception-payout-passkey';
import { cashPayoutCapCents, cashPayoutRefusal } from './wallet-cash-limits';
import { WalletChargesService } from './wallet-charges.service';
import { WalletPasskeysService } from './wallet-passkeys.service';

const KEY_USED = 'Esta petición de salida ya se usó para otra devolución';

/**
 * La salida de recepción (maqueta 4.5) con sus piezas: el PIN del cliente
 * (WalletChargesService), su Face ID (WalletPasskeysService y el QR de la
 * salida en ReceptionPayoutPasskeys), el 2FA del encargado y el registro.
 */
@Injectable()
export class ReceptionPayoutService {
  private readonly prisma: PrismaService;
  private readonly audit: AuditService;
  private readonly totp: TotpService;
  private readonly charges: WalletChargesService;
  private readonly passkeys: WalletPasskeysService;
  private readonly requests: ReceptionPayoutPasskeys;
  private readonly config: ConfigService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(AuditService) audit: AuditService,
    @Inject(TotpService) totp: TotpService,
    @Inject(WalletChargesService) charges: WalletChargesService,
    @Inject(WalletPasskeysService) passkeys: WalletPasskeysService,
    @Inject(ReceptionPayoutPasskeys) requests: ReceptionPayoutPasskeys,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.prisma = prisma;
    this.audit = audit;
    this.totp = totp;
    this.charges = charges;
    this.passkeys = passkeys;
    this.requests = requests;
    this.config = config;
  }

  private deps(actor: Actor): ReceptionPayoutDeps {
    return {
      prisma: this.prisma,
      audit: this.audit,
      totp: this.totp,
      checkPin: (walletId, pin) => this.charges.checkPinForPayout(actor, walletId, pin),
      hasPasskey: (walletId) => this.passkeys.hasPasskey(walletId),
      passkeyRequest: async (tenantId, requestKey) => (await this.requests.byRequestKey(tenantId, requestKey))?.request ?? null,
    };
  }

  plan(actor: Actor, walletId: string): Promise<ReceptionPayoutPlan> {
    return receptionPayoutPlan(this.deps(actor), actor, walletId);
  }

  payout(actor: Actor, walletId: string, input: ReceptionCashInput, device: ReceptionDevice = {}): Promise<ReceptionCashResult> {
    return receptionCashPayout(this.deps(actor), actor, walletId, input, device);
  }

  /**
   * El QR para que el cliente confirme esta salida con su Face ID en su
   * móvil. Con el NFC original delante y el importe de ahora; la misma
   * requestKey da el mismo QR.
   */
  async requestPasskey(
    actor: Actor,
    walletId: string,
    input: Pick<ReceptionCashInput, 'card' | 'uid' | 'expectedAmountCents' | 'requestKey'>,
  ): Promise<ReceptionPayoutPasskeyRequest> {
    assertPayoutInput(input);
    const venue = await payoutVenue(this.prisma, actor);
    assertMethodsEnabled(venue, ['wallet', 'nfc']);
    const { wallet, cash } = await payoutCardAndWallet(this.prisma, venue, walletId, input);
    if (!(await this.passkeys.hasPasskey(walletId))) {
      throw new ConflictException({ message: 'Este saldo no tiene Face ID: el cliente confirma con su PIN.', code: 'FACE_ID_NOT_SET' });
    }
    const amount = wallet.status === 'ACTIVE' ? cashPayoutCapCents(wallet.balanceCents, cash) : 0;
    if (amount <= 0) throw new ConflictException(cashPayoutRefusal(wallet.balanceCents, cash));
    if (amount !== input.expectedAmountCents) throw new ConflictException('El importe ha cambiado: vuelve a acercar el NFC y confirma lo que se devuelve');
    const used = await this.prisma.acrossVenues((tx) =>
      tx.walletPayout.findUnique({ where: { tenantId_requestKey: { tenantId: actor.tenantId, requestKey: input.requestKey } }, select: { id: true } }),
    );
    if (used) throw new ConflictException(KEY_USED);
    const before = await this.requests.byRequestKey(actor.tenantId, input.requestKey);
    if (before && (before.request.walletId !== walletId || before.request.userId !== actor.userId || before.request.amountCents !== amount)) {
      throw new ConflictException(KEY_USED);
    }
    const { token, request } = await this.requests.open({
      walletId, tenantId: actor.tenantId, userId: actor.userId, requestKey: input.requestKey, amountCents: amount, venueName: venue.name,
    });
    if (!before) {
      await this.audit.log({
        action: 'wallet.payout_passkey_requested', tenantId: actor.tenantId, actorId: actor.userId, targetType: 'ClientWallet', targetId: walletId,
        payload: { requestKey: input.requestKey, amountCents: amount },
      });
    }
    return { url: `${this.publicBase()}/w/salida/${token}`, expiresAt: request.expiresAt };
  }

  /** ¿Lo ha confirmado ya en su móvil? (recepción lo pregunta cada poco). */
  async passkeyStatus(actor: Actor, walletId: string, requestKey: string): Promise<ReceptionPayoutPasskeyStatus> {
    const found = await this.requests.byRequestKey(actor.tenantId, requestKey);
    if (!found || found.request.walletId !== walletId || found.request.userId !== actor.userId) return { status: 'expired' };
    return { status: found.request.confirmed ? 'confirmed' : 'waiting' };
  }

  // ─── La página del cliente (/w/salida/:token) ───────────────────────────

  async confirmView(token: string): Promise<PayoutConfirmView | null> {
    const request = await this.requests.byToken(token);
    return request ? { amountCents: request.amountCents, venueName: request.venueName, confirmed: request.confirmed } : null;
  }

  /** Reto para su llave, atado a esta salida (saldo y requestKey). */
  async challenge(token: string, host: string | undefined): Promise<unknown> {
    const request = await this.requests.byToken(token);
    if (!request) throw new NotFoundException({ message: 'Este QR ya no vale', code: 'PAYOUT_QR_GONE' });
    if (request.confirmed) throw new ConflictException({ message: 'Ya está confirmada', code: 'PAYOUT_CONFIRMED' });
    return this.passkeys.challenge(payoutPasskeyScope(request.walletId, request.requestKey), host);
  }

  /** Su móvil lo firmó con la llave de ESE saldo: queda confirmada para recepción. */
  async confirm(token: string, host: string | undefined, response: unknown): Promise<{ amountCents: number }> {
    const request = await this.requests.byToken(token);
    if (!request) throw new NotFoundException({ message: 'Este QR ya no vale', code: 'PAYOUT_QR_GONE' });
    const owner = await this.passkeys.verify(payoutPasskeyScope(request.walletId, request.requestKey), host, response);
    if (owner !== request.walletId) throw new ForbiddenException({ message: 'Confirma con el Face ID de este saldo.', code: 'FACE_ID_WRONG' });
    const confirmed = await this.requests.markConfirmed(token);
    if (!confirmed) throw new NotFoundException({ message: 'Este QR ya no vale', code: 'PAYOUT_QR_GONE' });
    await this.audit.log({
      action: 'wallet.payout_passkey_confirmed', tenantId: request.tenantId, targetType: 'ClientWallet', targetId: request.walletId,
      payload: { requestKey: request.requestKey, amountCents: request.amountCents, requestedBy: request.userId },
    });
    return { amountCents: request.amountCents };
  }

  private publicBase(): string {
    return (this.config.get<string>('NEXT_PUBLIC_API_URL') ?? 'http://localhost:4100').replace(/\/+$/, '');
  }
}
