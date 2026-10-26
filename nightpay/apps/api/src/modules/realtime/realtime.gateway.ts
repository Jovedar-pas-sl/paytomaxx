import { Inject, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import type { JwtPayload } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { legacySubscribeUntil } from '../../config/realtime-legacy';
import { bearerToken, verifyStaffToken } from '../../common/guards/staff-token';
import { AccessRevocationService, type AccessRevocation } from '../auth/access-revocation.service';
import { MetricsService } from '../metrics/metrics.service';
import type { PaymentMachineState } from '../payments/payment.machine';

/** Cobros a los que puede estar suscrita una conexión a la vez. */
export const MAX_ROOMS_PER_SOCKET = 20;
/** Sin sesión (apps antiguas) solo se siguen cobros de los últimos 30 min. */
export const LEGACY_SUBSCRIBE_WINDOW_MS = 30 * 60 * 1000;
/** Respuesta a un subscribe sin sesión pasada la fecha de corte. */
export const LEGACY_SUBSCRIBE_CLOSED_ERROR = 'Inicia sesión otra vez';
/** La sesión del handshake caducó (la conexión sigue abierta): hay que reconectar con el token nuevo. */
export const SESSION_EXPIRED_ERROR = 'Sesión caducada: vuelve a conectar';
/** La sesión del handshake se cerró (logout, revocada, baja): se corta la conexión. */
export const SESSION_REVOKED_ERROR = 'Sesión cerrada: vuelve a iniciar sesión';

const SubscribeSchema = z.object({ paymentId: z.string().uuid() });

type SubscribeResult = { ok: true; room: string } | { ok: false; error: string };
type StaffSocket = Socket & {
  data: { staff?: JwtPayload; legacyWarned?: boolean; legacyClosedLogged?: boolean; authReady?: Promise<void> };
};
type LegacyResult = 'allowed' | 'denied' | 'closed';

/**
 * Gateway WS para sincronizacion en tiempo real cliente movil ↔ TPV.
 *
 * Eventos:
 *   - cliente: payment:subscribe { paymentId } → server lo mete en room payment:<paymentId>
 *   - server → room: payment:update { paymentId, status, ... }
 *   - server → room: payment:completed { paymentId, status: AUTHORIZED|FAILED|EXPIRED, tipCents }
 *
 * Acceso: con la sesión del personal en el handshake (`auth: { token }` o
 * `Authorization: Bearer`), solo cobros de SU local y mientras ese token no
 * caduque (se mira en cada subscribe: la conexión puede durar más que él;
 * las apps reconectan con el token del momento). Sin sesión (versiones
 * antiguas en caché de las apps de la chica y del TPV) se mantiene, con aviso
 * en el log y la métrica nightpay_ws_legacy_subscribes_total, la suscripción a
 * cobros creados en los últimos 30 min, y solo hasta
 * REALTIME_LEGACY_SUBSCRIBE_UNTIL (por defecto el martes 2026-11-17 12:00 de Madrid).
 * Después se responde «Inicia sesión otra vez».
 * El id tiene que ser un UUID y hay un máximo de cobros por conexión.
 * Origen (CORS) restringido a CORS_ORIGINS en producción: ver realtime.adapter.ts.
 *
 * Sesión cerrada (logout, revocar sus sesiones, baja, contraseña nueva): al
 * revocarla se desconectan YA sus conexiones (salas session:<sid> y
 * user:<id>; con el adaptador de Redis, en todos los nodos), y un handshake
 * o un subscribe con un token de esa sesión se corta (por si el aviso no
 * llegó). Sin Redis para comprobarlo, se corta también (fail-closed); las
 * apps reconectan y, mientras, consultan el estado del cobro.
 */
@WebSocketGateway({ namespace: '/rt' })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly jwt: JwtService;
  private readonly prisma: PrismaService;
  private readonly metrics: MetricsService;
  private readonly revocations: AccessRevocationService;
  /** Hasta cuándo vale la vía sin sesión (null = apagada). */
  private readonly legacyUntil: Date | null;

  @WebSocketServer()
  server!: Server;

  constructor(
    @Inject(JwtService) jwt: JwtService,
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(MetricsService) metrics: MetricsService,
    @Inject(AccessRevocationService) revocations: AccessRevocationService,
    @Optional() @Inject(ConfigService) config?: ConfigService,
  ) {
    this.jwt = jwt;
    this.prisma = prisma;
    this.metrics = metrics;
    this.revocations = revocations;
    this.legacyUntil = legacySubscribeUntil(config?.get<string>('REALTIME_LEGACY_SUBSCRIBE_UNTIL'));
    revocations.onRevoked((revocation) => this.disconnectRevoked(revocation));
  }

  /** Al conectar: si trae la sesión del personal, se guarda (si no vale, como sin sesión). */
  async handleConnection(client: StaffSocket): Promise<void> {
    this.metrics.wsConnectionsActive.inc();
    // Un payment:subscribe puede llegar antes de que acabe la comprobación:
    // handleSubscribe espera a esta promesa (si no, iría por la vía sin sesión).
    client.data.authReady = this.authenticate(client);
    await client.data.authReady;
  }

  private async authenticate(client: StaffSocket): Promise<void> {
    const token = handshakeToken(client);
    if (!token) return;
    const result = await verifyStaffToken(this.jwt, token);
    if (!result.ok) {
      this.logger.debug(`socket ${client.id}: sesión rechazada (${result.reason})`);
      return;
    }
    // Token de una sesión cerrada: fuera (no baja a la vía sin sesión).
    if (await this.sessionClosed(result.payload)) {
      this.logger.debug(`socket ${client.id}: sesión cerrada, se desconecta`);
      client.disconnect(true);
      return;
    }
    client.data.staff = result.payload;
    // Salas para cortar sus conexiones al revocar la sesión o a la persona.
    await client.join(sessionRooms(result.payload));
  }

  handleDisconnect(): void {
    this.metrics.wsConnectionsActive.dec();
  }

  @SubscribeMessage('payment:subscribe')
  async handleSubscribe(@MessageBody() data: unknown, @ConnectedSocket() client: StaffSocket): Promise<SubscribeResult> {
    const parsed = SubscribeSchema.safeParse(data);
    if (!parsed.success) return { ok: false, error: 'paymentId inválido' };
    if (subscribedRooms(client) >= MAX_ROOMS_PER_SOCKET) return { ok: false, error: 'Demasiadas suscripciones' };

    const { paymentId } = parsed.data;
    await client.data.authReady;
    const staff = client.data.staff;
    if (staff && tokenExpired(staff)) return { ok: false, error: SESSION_EXPIRED_ERROR };
    if (staff && (await this.sessionClosed(staff))) {
      // La sesión se cerró con la conexión abierta (y el aviso no la cortó).
      client.disconnect(true);
      return { ok: false, error: SESSION_REVOKED_ERROR };
    }
    if (!staff && !this.legacyOpen()) return this.rejectLegacy(client);

    const allowed = staff
      ? await this.staffMaySubscribe(staff, paymentId)
      : await this.legacyMaySubscribe(client, paymentId);
    if (!allowed) return { ok: false, error: 'Cobro no encontrado' };

    const room = `payment:${paymentId}`;
    await client.join(room);
    this.logger.debug(`socket ${client.id} joined ${room}`);
    return { ok: true, room };
  }

  @SubscribeMessage('payment:unsubscribe')
  async handleUnsubscribe(
    @MessageBody() data: unknown,
    @ConnectedSocket() client: StaffSocket,
  ): Promise<{ ok: boolean }> {
    const parsed = SubscribeSchema.safeParse(data);
    if (!parsed.success) return { ok: false };
    await client.leave(`payment:${parsed.data.paymentId}`);
    return { ok: true };
  }

  /** API publica para que PaymentsService emita updates. */
  emitPaymentUpdate(paymentId: string, status: PaymentMachineState, amountCents: number): void {
    this.server.to(`payment:${paymentId}`).emit('payment:update', {
      type: 'payment:update',
      paymentId,
      status,
      amountCents,
      timestamp: new Date().toISOString(),
    });
  }

  /** Estado terminal — cliente puede mostrar "completado" / "rechazado". */
  emitPaymentCompleted(
    paymentId: string,
    status: 'AUTHORIZED' | 'FAILED' | 'EXPIRED' | 'CANCELED',
    tipCents = 0,
  ): void {
    this.server.to(`payment:${paymentId}`).emit('payment:completed', {
      type: 'payment:completed',
      paymentId,
      status,
      // Propina que dejó el cliente (Fase 1B) — la chica la ve al confirmarse.
      tipCents,
      timestamp: new Date().toISOString(),
    });
  }

  /** ¿Se cerró la sesión de este token? Sin Redis para saberlo, se da por cerrada (fail-closed). */
  private async sessionClosed(staff: JwtPayload): Promise<boolean> {
    try {
      return await this.revocations.isRevoked(staff);
    } catch {
      return true;
    }
  }

  /** Revocada una sesión o una persona: se cortan ya sus conexiones (todos los nodos, por el adaptador). */
  private disconnectRevoked(revocation: AccessRevocation): void {
    if (!this.server) return;
    const room = revocation.kind === 'session' ? sessionRoom(revocation.sid) : userRoom(revocation.userId);
    this.server.in(room).disconnectSockets(true);
  }

  private async staffMaySubscribe(staff: JwtPayload, paymentId: string): Promise<boolean> {
    const payment = await this.findPayment(paymentId);
    return payment !== null && payment.tenantId === staff.tenantId;
  }

  /** Vía sin sesión, mientras siga abierta: solo cobros recientes. */
  private async legacyMaySubscribe(client: StaffSocket, paymentId: string): Promise<boolean> {
    this.warnLegacy(client);
    const payment = await this.findPayment(paymentId);
    const allowed = payment !== null && Date.now() - payment.createdAt.getTime() <= LEGACY_SUBSCRIBE_WINDOW_MS;
    this.countLegacy(allowed ? 'allowed' : 'denied');
    return allowed;
  }

  /** Consulta de sistema: el local se comprueba en quien llama, contra el de la sesión. */
  private findPayment(paymentId: string): Promise<{ tenantId: string; createdAt: Date } | null> {
    return this.prisma.asSystem((tx) =>
      tx.payment.findUnique({ where: { id: paymentId }, select: { tenantId: true, createdAt: true } }),
    );
  }

  private legacyOpen(): boolean {
    return this.legacyUntil !== null && Date.now() < this.legacyUntil.getTime();
  }

  /** Pasada la fecha de corte: sin sesión no hay suscripción (sin mirar el cobro). */
  private rejectLegacy(client: StaffSocket): SubscribeResult {
    this.countLegacy('closed');
    if (!client.data.legacyClosedLogged) {
      client.data.legacyClosedLogged = true;
      this.logger.warn(
        `socket ${client.id}: payment:subscribe sin sesión rechazado (la vía antigua se cerró${this.legacyUntil ? ` el ${this.legacyUntil.toISOString()}` : ''}). La app tiene que volver a iniciar sesión.`,
      );
    }
    return { ok: false, error: LEGACY_SUBSCRIBE_CLOSED_ERROR };
  }

  private countLegacy(result: LegacyResult): void {
    this.metrics.wsLegacySubscribes.inc({ result });
  }

  private warnLegacy(client: StaffSocket): void {
    if (client.data.legacyWarned) return;
    client.data.legacyWarned = true;
    this.logger.warn(
      `socket ${client.id}: payment:subscribe sin sesión (OBSOLETO). La app debe conectar con io(url, { auth: { token } }); de momento solo cobros de los últimos 30 min, hasta ${this.legacyUntil?.toISOString()}.`,
    );
  }
}

function handshakeToken(client: Socket): string | null {
  const auth = client.handshake?.auth as { token?: unknown } | undefined;
  if (typeof auth?.token === 'string' && auth.token.length > 0) return auth.token.replace(/^Bearer\s+/i, '');
  return bearerToken(client.handshake?.headers?.authorization);
}

function sessionRoom(sid: string): string {
  return `session:${sid}`;
}

function userRoom(userId: string): string {
  return `user:${userId}`;
}

/** Las salas de la sesión del token y de su persona (sin sid, la de la persona). */
function sessionRooms(staff: JwtPayload): string[] {
  return staff.sid ? [sessionRoom(staff.sid), userRoom(staff.sub)] : [userRoom(staff.sub)];
}

/** `exp` del JWT (s) ya pasado. Los tokens de sesión siempre lo llevan (AuthService). */
function tokenExpired(staff: JwtPayload, now = Date.now()): boolean {
  return typeof staff.exp === 'number' && staff.exp * 1000 <= now;
}

/** Salas de cobro de la conexión (la sala propia del socket no cuenta). */
function subscribedRooms(client: Socket): number {
  return [...client.rooms].filter((room) => room.startsWith('payment:')).length;
}
