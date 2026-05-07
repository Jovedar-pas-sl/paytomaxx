import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { PaymentMachineState } from '../payments/payment.machine';

/**
 * Gateway WS para sincronizacion en tiempo real cliente movil ↔ TPV.
 *
 * Eventos:
 *   - cliente: payment:subscribe { qrToken } → server lo mete en room payment:<paymentId>
 *   - server → room: payment:update { paymentId, status, ... }
 *   - server → room: payment:completed { paymentId, status: AUTHORIZED|FAILED|EXPIRED }
 *
 * Sin auth (simplicidad Sprint 5): la "seguridad" es que el qrToken es UUID v4
 * y solo lo conoce quien escaneo el QR.
 */
@WebSocketGateway({ namespace: '/rt', cors: { origin: true, credentials: true } })
export class RealtimeGateway {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  @SubscribeMessage('payment:subscribe')
  async handleSubscribe(
    @MessageBody() data: { paymentId: string },
    @ConnectedSocket() client: Socket,
  ): Promise<{ ok: boolean; room: string }> {
    const room = `payment:${data.paymentId}`;
    await client.join(room);
    this.logger.debug(`socket ${client.id} joined ${room}`);
    return { ok: true, room };
  }

  @SubscribeMessage('payment:unsubscribe')
  async handleUnsubscribe(
    @MessageBody() data: { paymentId: string },
    @ConnectedSocket() client: Socket,
  ): Promise<{ ok: boolean }> {
    await client.leave(`payment:${data.paymentId}`);
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
    status: 'AUTHORIZED' | 'FAILED' | 'EXPIRED',
  ): void {
    this.server.to(`payment:${paymentId}`).emit('payment:completed', {
      type: 'payment:completed',
      paymentId,
      status,
      timestamp: new Date().toISOString(),
    });
  }
}
