import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  stepUpActions,
  type BtcpayPurpose,
  type BtcpaySettingsView,
  type BtcpayTestResult,
  type BtcpayTestStep,
  type JwtPayload,
  type SaveBtcpaySettingsDto,
  type TestBtcpaySettingsDto,
  type UpdateBtcpayModeDto,
} from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TotpService } from '../auth/totp.service';
import { GatewayTransientError } from '../gateways/gateway-errors';
import { BtcpayApiError, BtcpayClients, type BtcpayClient } from './btcpay-client';
import { checkKeyPermissions } from './btcpay-logic';
import { BtcpayBlockedError, BtcpayNet, BtcpayResponseError } from './btcpay-net';
import { btcpayEnabled } from './btcpay-flag';
import { openBtcpaySecret, sealBtcpaySecret } from './btcpay-secrets';
import { parseBtcpayUrl } from './btcpay-url';

/** La conexión de un local ya descifrada: solo dentro del servidor. */
export interface BtcpayAccess {
  tenantId: string;
  origin: string;
  storeId: string;
  apiKey: string;
  webhookSecret: string | null;
  hookToken: string;
  enabled: boolean;
  purpose: BtcpayPurpose;
}

const HOOK_TOKEN_BYTES = 24;
/** BTCPay admite como mucho 64 caracteres de secreto. */
const WEBHOOK_SECRET_BYTES = 32;

const BTCPAY_UNAVAILABLE = 'El pago con bitcoin no está disponible en este servidor.';

/** Mensaje para el dueño de un fallo al hablar con BTCPay (sin el texto crudo de BTCPay ni la clave). */
export function messageOfBtcpayError(err: unknown): string {
  if (err instanceof BtcpayBlockedError) return err.message;
  if (err instanceof BtcpayApiError) return err.failure.message;
  if (err instanceof BtcpayResponseError) return 'BTCPay ha contestado de una forma que no se acepta (redirección o respuesta enorme). Revisa la dirección.';
  if (err instanceof GatewayTransientError) return 'No se ha podido hablar con BTCPay. Revisa la dirección y que esté encendido, y prueba de nuevo.';
  return 'No se ha podido comprobar BTCPay.';
}

@Injectable()
export class BtcpayStoreService {
  private readonly logger = new Logger(BtcpayStoreService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(BtcpayNet) private readonly net: BtcpayNet,
    @Inject(BtcpayClients) private readonly clients: BtcpayClients,
    @Inject(TotpService) private readonly totp: TotpService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private kek(): string | undefined {
    return this.config.get<string>('ENCRYPTION_KEK');
  }

  // ─── Lo que ve el dueño ─────────────────────────────────────────────

  async view(tenantId: string): Promise<BtcpaySettingsView> {
    const available = btcpayEnabled();
    const row = await this.prisma.asSystem((tx) => tx.btcpayStore.findUnique({ where: { tenantId } }));
    if (!row) {
      return {
        available,
        configured: false,
        enabled: false,
        purpose: 'BOTH',
        baseUrl: null,
        storeId: null,
        apiKeyHint: null,
        webhookRegistered: false,
        lastCheckAt: null,
        lastCheckOk: null,
        lastCheckMessage: null,
      };
    }
    return {
      available,
      configured: true,
      enabled: row.enabled,
      purpose: row.purpose as BtcpayPurpose,
      baseUrl: row.baseUrl,
      storeId: row.storeId,
      apiKeyHint: this.hintOf(tenantId, row.apiKeyEnc),
      webhookRegistered: Boolean(row.webhookId && row.webhookSecretEnc),
      lastCheckAt: row.lastCheckAt?.toISOString() ?? null,
      lastCheckOk: row.lastCheckOk,
      lastCheckMessage: row.lastCheckMessage,
    };
  }

  /** «…a1b2»: las últimas 4 de la clave, para saber cuál hay sin enseñarla. */
  private hintOf(tenantId: string, sealed: string): string | null {
    try {
      return `…${openBtcpaySecret(this.kek(), tenantId, 'apikey', sealed).slice(-4)}`;
    } catch {
      return null;
    }
  }

  // ─── Para el resto del servidor ─────────────────────────────────────

  async accessFor(tenantId: string): Promise<BtcpayAccess | null> {
    const row = await this.prisma.asSystem((tx) => tx.btcpayStore.findUnique({ where: { tenantId } }));
    return row ? this.accessOf(row) : null;
  }

  /** El token de la ruta del aviso identifica al local ANTES de verificar la firma. */
  async accessByHookToken(hookToken: string): Promise<BtcpayAccess | null> {
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(hookToken)) return null;
    const row = await this.prisma.asSystem((tx) => tx.btcpayStore.findUnique({ where: { hookToken } }));
    return row ? this.accessOf(row) : null;
  }

  private accessOf(row: {
    tenantId: string;
    baseUrl: string;
    storeId: string;
    apiKeyEnc: string;
    webhookSecretEnc: string | null;
    hookToken: string;
    enabled: boolean;
    purpose: string;
  }): BtcpayAccess | null {
    try {
      return {
        tenantId: row.tenantId,
        origin: row.baseUrl,
        storeId: row.storeId,
        apiKey: openBtcpaySecret(this.kek(), row.tenantId, 'apikey', row.apiKeyEnc),
        webhookSecret: row.webhookSecretEnc ? openBtcpaySecret(this.kek(), row.tenantId, 'webhook', row.webhookSecretEnc) : null,
        hookToken: row.hookToken,
        enabled: row.enabled,
        purpose: row.purpose as BtcpayPurpose,
      };
    } catch (err) {
      // Nunca el valor: solo que no se pudo abrir (ENCRYPTION_KEK cambiada, fila tocada).
      this.logger.error(`No se pudo abrir la conexión de BTCPay del local ${row.tenantId}: ${(err as Error).message}`);
      return null;
    }
  }

  clientFor(access: Pick<BtcpayAccess, 'tenantId' | 'origin' | 'storeId' | 'apiKey'>): BtcpayClient {
    return this.clients.forStore(access);
  }

  // ─── Probar conexión ────────────────────────────────────────────────

  /** Health → permisos de la clave → tienda. Para en el primer paso que falla. */
  async runTest(client: BtcpayClient, storeId: string): Promise<BtcpayTestResult> {
    const steps: BtcpayTestStep[] = [];
    let missing: string[] = [];
    let extra: string[] = [];
    const finish = (): BtcpayTestResult => ({ ok: steps.length === 3 && steps.every((s) => s.ok), steps, missingPermissions: missing, extraPermissions: extra });

    try {
      const health = await client.health();
      steps.push(
        health.synchronized
          ? { id: 'health', ok: true, message: 'BTCPay responde y está al día.' }
          : { id: 'health', ok: false, message: 'BTCPay responde, pero todavía se está sincronizando con la red de bitcoin. Prueba dentro de un rato.' },
      );
      if (!health.synchronized) return finish();
    } catch (err) {
      steps.push({ id: 'health', ok: false, message: messageOfBtcpayError(err) });
      return finish();
    }

    try {
      const { permissions } = await client.currentKey();
      const check = checkKeyPermissions(permissions, storeId);
      missing = check.missing;
      extra = check.extra;
      if (!check.ok) {
        steps.push({ id: 'key', ok: false, message: `A la clave le faltan permisos: ${check.missing.join(', ')}.` });
        return finish();
      }
      steps.push({
        id: 'key',
        ok: true,
        message: check.extra.length > 0
          ? `La clave sirve, pero tiene permisos de más: ${check.extra.join(', ')}. Es mejor una clave solo con los tres que se piden.`
          : 'La clave tiene justo los permisos que hacen falta.',
      });
    } catch (err) {
      steps.push({ id: 'key', ok: false, message: messageOfBtcpayError(err) });
      return finish();
    }

    try {
      await client.probeStore();
      steps.push({ id: 'store', ok: true, message: 'La tienda existe y la clave llega a ella.' });
    } catch (err) {
      steps.push({ id: 'store', ok: false, message: messageOfBtcpayError(err) });
    }
    return finish();
  }

  /** «Probar conexión» del panel: lo guardado, o lo que se está escribiendo (sin guardarlo). */
  async test(tenantId: string, dto: TestBtcpaySettingsDto): Promise<BtcpayTestResult> {
    this.assertAvailable();
    const saved = await this.accessFor(tenantId);
    const typed = dto.baseUrl !== undefined || dto.storeId !== undefined || dto.apiKey !== undefined;
    let origin: string;
    let storeId: string;
    let apiKey: string;
    if (!typed) {
      if (!saved) throw new BadRequestException({ code: 'BTCPAY_NOT_CONFIGURED', message: 'Todavía no hay datos de BTCPay guardados. Escríbelos y pulsa «Probar conexión».' });
      ({ origin, storeId, apiKey } = saved);
    } else {
      const parsed = this.parseUrlOrThrow(dto.baseUrl ?? saved?.origin ?? '');
      origin = parsed;
      storeId = dto.storeId ?? saved?.storeId ?? '';
      const key = this.keyForChange(saved, origin, storeId, dto.apiKey);
      apiKey = key;
    }
    await this.assertHostOrThrow(origin);
    const result = await this.runTest(this.clients.forStore({ tenantId, origin, storeId, apiKey }), storeId);
    if (!typed && saved) await this.recordCheck(tenantId, result);
    return result;
  }

  // ─── Guardar ────────────────────────────────────────────────────────

  async save(user: JwtPayload, dto: SaveBtcpaySettingsDto): Promise<BtcpaySettingsView> {
    this.assertAvailable();
    const tenantId = user.tenantId;
    const origin = this.parseUrlOrThrow(dto.baseUrl);
    // La 2FA primero: sin ella no se llama a ningún sitio.
    await this.totp.assertForUser(user.sub, dto.totpCode, stepUpActions.btcpay(tenantId));
    await this.assertHostOrThrow(origin);

    const saved = await this.accessFor(tenantId);
    const apiKey = this.keyForChange(saved, origin, dto.storeId, dto.apiKey);
    const client = this.clients.forStore({ tenantId, origin, storeId: dto.storeId, apiKey });
    const result = await this.runTest(client, dto.storeId);
    if (!result.ok) {
      throw new BadRequestException({
        code: 'BTCPAY_TEST_FAILED',
        message: result.steps.find((s) => !s.ok)?.message ?? 'No se pudo comprobar BTCPay.',
        steps: result.steps,
      });
    }

    const hookToken = saved?.hookToken ?? randomBytes(HOOK_TOKEN_BYTES).toString('base64url');
    const secret = randomBytes(WEBHOOK_SECRET_BYTES).toString('hex');
    const hookUrl = this.hookUrl(hookToken);
    const previous = await this.prisma.asSystem((tx) => tx.btcpayStore.findUnique({ where: { tenantId }, select: { webhookId: true } }));
    const webhookId = await this.registerWebhook({ client, saved, origin, storeId: dto.storeId, previousWebhookId: previous?.webhookId ?? null, hookUrl, secret });

    const now = new Date();
    const data = {
      baseUrl: origin,
      storeId: dto.storeId,
      apiKeyEnc: sealBtcpaySecret(this.kek(), tenantId, 'apikey', apiKey),
      webhookSecretEnc: sealBtcpaySecret(this.kek(), tenantId, 'webhook', secret),
      webhookId,
      hookToken,
      enabled: dto.enabled,
      purpose: dto.purpose,
      lastCheckAt: now,
      lastCheckOk: true,
      lastCheckMessage: 'Conexión correcta.',
    };
    try {
      await this.prisma.asSystem((tx) =>
        tx.btcpayStore.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data }),
      );
    } catch (err) {
      // El aviso ya está en BTCPay pero no hay dónde recibirlo: se quita para no dejarlo huérfano.
      await client.deleteWebhook(webhookId).catch(() => undefined);
      throw err;
    }
    await this.audit.log({
      action: 'venue.btcpay.updated',
      tenantId,
      actorId: user.sub,
      actorEmail: user.email,
      targetType: 'Venue',
      targetId: tenantId,
      // Nunca la clave ni el secreto: solo qué se tocó.
      payload: { baseUrl: origin, storeId: dto.storeId, enabled: dto.enabled, purpose: dto.purpose, apiKeyChanged: dto.apiKey !== undefined, previouslyConfigured: Boolean(saved) },
    });
    return this.view(tenantId);
  }

  /** Solo el interruptor y el uso, con 2FA. Para encender hace falta que la última comprobación saliera bien. */
  async updateMode(user: JwtPayload, dto: UpdateBtcpayModeDto): Promise<BtcpaySettingsView> {
    this.assertAvailable();
    const tenantId = user.tenantId;
    const row = await this.prisma.asSystem((tx) => tx.btcpayStore.findUnique({ where: { tenantId } }));
    if (!row) throw new ConflictException({ code: 'BTCPAY_NOT_CONFIGURED', message: 'Primero guarda los datos de tu BTCPay.' });
    await this.totp.assertForUser(user.sub, dto.totpCode, stepUpActions.btcpay(tenantId));
    if (dto.enabled && row.lastCheckOk !== true) {
      throw new ConflictException({ code: 'BTCPAY_NOT_TESTED', message: 'Pulsa «Probar conexión» y que salga bien antes de encender el pago con bitcoin.' });
    }
    await this.prisma.asSystem((tx) => tx.btcpayStore.update({ where: { tenantId }, data: { enabled: dto.enabled, purpose: dto.purpose } }));
    await this.audit.log({
      action: 'venue.btcpay.mode_updated',
      tenantId,
      actorId: user.sub,
      actorEmail: user.email,
      targetType: 'Venue',
      targetId: tenantId,
      payload: { before: { enabled: row.enabled, purpose: row.purpose }, after: { enabled: dto.enabled, purpose: dto.purpose } },
    });
    return this.view(tenantId);
  }

  // ─── Detalles ───────────────────────────────────────────────────────

  private assertAvailable(): void {
    if (!btcpayEnabled()) throw new ConflictException({ code: 'BTCPAY_UNAVAILABLE', message: BTCPAY_UNAVAILABLE });
  }

  private parseUrlOrThrow(raw: string): string {
    const parsed = parseBtcpayUrl(raw);
    if (!parsed.ok) throw new BadRequestException({ code: `BTCPAY_URL_${parsed.code}`, message: parsed.message });
    return parsed.origin;
  }

  private async assertHostOrThrow(origin: string): Promise<void> {
    try {
      await this.net.checkHost(origin);
    } catch (err) {
      if (err instanceof BtcpayBlockedError) throw new BadRequestException({ code: `BTCPAY_URL_${err.code}`, message: err.message });
      throw err;
    }
  }

  /**
   * La clave que se usará. Si no se escribe, vale la guardada SOLO con la misma
   * dirección y la misma tienda: cambiar la dirección con la clave vieja la
   * mandaría a un tercero.
   */
  private keyForChange(saved: BtcpayAccess | null, origin: string, storeId: string, typedKey: string | undefined): string {
    if (typedKey) return typedKey;
    if (saved && saved.origin === origin && saved.storeId === storeId) return saved.apiKey;
    throw new BadRequestException({ code: 'BTCPAY_KEY_REQUIRED', message: 'Al cambiar la dirección o la tienda hay que escribir también la clave de API.' });
  }

  private hookUrl(hookToken: string): string {
    const base = this.config.get<string>('NEXT_PUBLIC_API_URL');
    if (!base) throw new ConflictException({ code: 'BTCPAY_NO_PUBLIC_URL', message: 'El servidor no conoce su dirección pública (NEXT_PUBLIC_API_URL): no puede registrar el aviso en BTCPay.' });
    return `${base.replace(/\/+$/, '')}/v1/webhooks/btcpay/${hookToken}`;
  }

  /** El aviso en BTCPay: se actualiza el que había (misma tienda) o se quita y se crea. Devuelve su id. */
  private async registerWebhook(input: {
    client: BtcpayClient;
    saved: BtcpayAccess | null;
    origin: string;
    storeId: string;
    previousWebhookId: string | null;
    hookUrl: string;
    secret: string;
  }): Promise<string> {
    const { client, saved, origin, storeId, previousWebhookId, hookUrl, secret } = input;
    const sameStore = Boolean(saved && saved.origin === origin && saved.storeId === storeId);
    try {
      if (previousWebhookId && sameStore) {
        try {
          await client.updateWebhook(previousWebhookId, { url: hookUrl, secret });
          return previousWebhookId;
        } catch (err) {
          // Lo borraron en BTCPay: se crea de nuevo. Cualquier otro fallo, al dueño.
          if (!(err instanceof BtcpayApiError) || err.status !== 404) throw err;
        }
      }
      if (previousWebhookId && saved && !sameStore) {
        // Otra tienda u otro BTCPay: el aviso de la anterior se quita con SU clave (si aún responde).
        await this.clients
          .forStore({ tenantId: saved.tenantId, origin: saved.origin, storeId: saved.storeId, apiKey: saved.apiKey })
          .deleteWebhook(previousWebhookId)
          .catch((e: unknown) => this.logger.warn(`No se pudo quitar el aviso anterior de BTCPay (local ${saved.tenantId}): ${(e as Error).message}`));
      }
      const created = await client.createWebhook({ url: hookUrl, secret });
      return created.id;
    } catch (err) {
      throw new BadRequestException({ code: 'BTCPAY_WEBHOOK_FAILED', message: `No se pudo registrar el aviso en BTCPay. ${messageOfBtcpayError(err)}` });
    }
  }

  private async recordCheck(tenantId: string, result: BtcpayTestResult): Promise<void> {
    const failed = result.steps.find((s) => !s.ok);
    await this.prisma
      .asSystem((tx) =>
        tx.btcpayStore.update({
          where: { tenantId },
          data: { lastCheckAt: new Date(), lastCheckOk: result.ok, lastCheckMessage: result.ok ? 'Conexión correcta.' : (failed?.message ?? 'Falló la comprobación.') },
        }),
      )
      .catch((e: unknown) => this.logger.warn(`No se pudo apuntar la comprobación de BTCPay (local ${tenantId}): ${(e as Error).message}`));
  }
}
