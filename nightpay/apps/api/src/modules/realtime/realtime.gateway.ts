import { Inject, Logger } from '@nestjs/common';
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
import { bearerToken, verifyStaffToken } from '../../common/guards/staff-token';
import { MetricsService } from '../metrics/metrics.service';
import type { PaymentMachineState } from '../payments/payment.machine';

/** Cobros a los que puede estar suscrita una conexión a la vez. */
export const MAX_ROOMS_PER_SOCKET = 20;
/** Sin sesión (apps antiguas) solo se siguen cobros de los últimos 30 min. */
export const LEGACY_SUBSCRIBE_WINDOW_MS = 30 * 60 * 1000;

const SubscribeSchema = z.object({ paymentId: z.string().uuid() });

type SubscribeResult = { ok: true; room: string } | { ok: false; error: string };
type StaffSocket = Socket & { data: { staff?: JwtPayload; legacyWarned?: boolean; authReady?: Promise<void> } };

/**
 * Gateway WS para sincronizacion en tiempo real cliente movil ↔ TPV.
 *
 * Eventos:
 *   - cliente: payment:subscribe { paymentId } → server lo mete en room payment:<paymentId>
 *   - server → room: payment:update { paymentId, status, ... }
 *   - server → room: payment:completed { paymentId, status: AUTHORIZED|FAILED|EXPIRED, tipCents }
 *
 * Acceso: con la sesión del personal en el handshake (`auth: { token }` o
 * `Authorization: Bearer`), solo cobros de SU local. Sin sesión (apps de la
 * chica y del TPV que aún no mandan el token) se mantiene, de forma temporal y
 * con aviso en el log, la suscripción a cobros creados en los últimos 30 min.
 * El id tiene que ser un UUID y hay un máximo de cobros por conexión.
 * Origen (CORS) restringido a CORS_ORIGINS en producción: ver realtime.adapter.ts.
 */
@WebSocketGateway({ namespace: '/rt' })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly jwt: JwtService;
  private readonly prisma: PrismaService;
  private readonly metrics: MetricsService;

  @WebSocketServer()
  server!: Server;

  constructor(
    @Inject(JwtService) jwt: JwtService,
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(MetricsService) metrics: MetricsService,
  ) {
    this.jwt = jwt;
    this.prisma = prisma;
    this.metrics = metrics;
  }

  /** Al conectar: si trae la sesión del personal, se guarda (si no vale, como sin sesión). */
  async handleConnection(client: StaffSocket): Promise<void> {
    this.metrics.wsConnectionsActive.inc();
    // Un payment:subscribe puede llegar antes de que acabe la comprobación:
    // maySubscribe espera a esta promesa (si no, iría por la vía sin sesión).
    client.data.authReady = this.authenticate(client);
    await client.data.authReady;
  }

  private async authenticate(client: StaffSocket): Promise<void> {
    const token = handshakeToken(client);
    if (!token) return;
    const result = await verifyStaffToken(this.jwt, token);
    if (result.ok) client.data.staff = result.payload;
    else this.logger.debug(`socket ${client.id}: sesión rechazada (${result.reason})`);
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
    const allowed = await this.maySubscribe(client, paymentId);
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

  private async maySubscribe(client: StaffSocket, paymentId: string): Promise<boolean> {
    await client.data.authReady;
    // Consulta de sistema: el local se comprueba aquí, contra el de la sesión.
    const payment = await this.prisma.asSystem((tx) =>
      tx.payment.findUnique({ where: { id: paymentId }, select: { tenantId: true, createdAt: true } }),
    );
    if (!payment) return false;
    const staff = client.data.staff;
    if (staff) return payment.tenantId === staff.tenantId;
    this.warnLegacy(client);
    return Date.now() - payment.createdAt.getTime() <= LEGACY_SUBSCRIBE_WINDOW_MS;
  }

  private warnLegacy(client: StaffSocket): void {
    if (client.data.legacyWarned) return;
    client.data.legacyWarned = true;
    this.logger.warn(
      `socket ${client.id}: payment:subscribe sin sesión (OBSOLETO). La app debe conectar con io(url, { auth: { token } }); de momento solo cobros de los últimos 30 min.`,
    );
  }
}

function handshakeToken(client: Socket): string | null {
  const auth = client.handshake?.auth as { token?: unknown } | undefined;
  if (typeof auth?.token === 'string' && auth.token.length > 0) return auth.token.replace(/^Bearer\s+/i, '');
  return bearerToken(client.handshake?.headers?.authorization);
}

/** Salas de cobro de la conexión (la sala propia del socket no cuenta). */
function subscribedRooms(client: Socket): number {
  return [...client.rooms].filter((room) => room.startsWith('payment:')).length;
}
