import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@nightpay/db';
import { openMinuteOf, openTimeText, type ReservationAccounting, type ReservationPackageInput, type ReservationPackageView } from '@nightpay/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { madridAt, nextDay, NIGHT_CUTOFF_HOUR } from '../../common/time/madrid';
import { AuditService } from '../audit/audit.service';
import { isRealDay, newReservationsCode } from './reservation-rules';
import { packageView } from './reservation-views';
import type { StaffActor } from './reservation-ops.service';

/** Sin NEXT_PUBLIC_API_URL (solo en local): el API en su puerto. */
const LOCAL_API_ORIGIN = 'http://localhost:4100';
const MAX_CODE_ATTEMPTS = 5;

export interface ReservationSettingsView {
  enabled: boolean;
  /** La hora de apertura («22:30»): las 48 h y el «hasta 2 h antes» cuentan desde ella. */
  openTime: string;
  /** El enlace para reservar desde la web (null: aún sin código). */
  url: string | null;
}

/**
 * Reservados: los paquetes (dueño o encargado), el enlace del local para
 * reservar desde la web (dueño) y «Señales de reservas» (contabilidad aparte).
 */
@Injectable()
export class ReservationCatalogService {
  readonly origin: string;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.origin = originOf(config.get<string>('NEXT_PUBLIC_API_URL')) ?? LOCAL_API_ORIGIN;
  }

  // ─── Paquetes ──────────────────────────────────────────────────────

  async packages(actor: StaffActor): Promise<ReservationPackageView[]> {
    const rows = await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.reservationPackage.findMany({ where: { tenantId: actor.tenantId }, orderBy: [{ active: 'desc' }, { priceCents: 'asc' }] }),
    );
    return rows.map(packageView);
  }

  async createPackage(actor: StaffActor, dto: ReservationPackageInput): Promise<ReservationPackageView> {
    const row = await this.prisma.withTenant(actor.tenantId, (tx) => tx.reservationPackage.create({ data: { tenantId: actor.tenantId, ...packageData(dto) } }));
    await this.audit.log({ action: 'reservation_package.created', tenantId: actor.tenantId, actorId: actor.userId, targetType: 'ReservationPackage', targetId: row.id, payload: { ...dto } });
    return packageView(row);
  }

  /** Cambiar un paquete no cambia las reservas ya hechas (guardan su copia). */
  async updatePackage(actor: StaffActor, id: string, dto: ReservationPackageInput): Promise<ReservationPackageView> {
    const row = await this.prisma.withTenant(actor.tenantId, async (tx) => {
      const found = await tx.reservationPackage.findFirst({ where: { id, tenantId: actor.tenantId }, select: { id: true } });
      if (!found) throw new NotFoundException('Paquete no encontrado');
      return tx.reservationPackage.update({ where: { id }, data: packageData(dto) });
    });
    await this.audit.log({ action: 'reservation_package.updated', tenantId: actor.tenantId, actorId: actor.userId, targetType: 'ReservationPackage', targetId: id, payload: { ...dto } });
    return packageView(row);
  }

  async setPackageActive(actor: StaffActor, id: string, active: boolean): Promise<ReservationPackageView> {
    const row = await this.prisma.withTenant(actor.tenantId, async (tx) => {
      const found = await tx.reservationPackage.findFirst({ where: { id, tenantId: actor.tenantId }, select: { id: true } });
      if (!found) throw new NotFoundException('Paquete no encontrado');
      return tx.reservationPackage.update({ where: { id }, data: { active } });
    });
    await this.audit.log({ action: 'reservation_package.active', tenantId: actor.tenantId, actorId: actor.userId, targetType: 'ReservationPackage', targetId: id, payload: { active } });
    return packageView(row);
  }

  // ─── El enlace del local ───────────────────────────────────────────

  async settings(venueId: string): Promise<ReservationSettingsView> {
    const v = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { reservationsEnabled: true, reservationsCode: true, reservationsOpenMinute: true },
    });
    if (!v) throw new NotFoundException('Local no encontrado');
    return {
      enabled: v.reservationsEnabled,
      openTime: openTimeText(v.reservationsOpenMinute),
      url: v.reservationsCode ? `${this.origin}/reservar/${v.reservationsCode}` : null,
    };
  }

  /** La hora de apertura del local (dueño o encargado). */
  async setOpenTime(actor: StaffActor, openTime: string): Promise<ReservationSettingsView> {
    const minute = openMinuteOf(openTime);
    if (minute === null) throw new ConflictException('Pon la hora como 22:30');
    await this.prisma.venue.update({ where: { id: actor.tenantId }, data: { reservationsOpenMinute: minute } });
    await this.audit.log({ action: 'reservations.open_time', tenantId: actor.tenantId, actorId: actor.userId, targetType: 'Venue', targetId: actor.tenantId, payload: { openTime } });
    return this.settings(actor.tenantId);
  }

  /** Encender crea el código (si no tiene); apagar lo conserva. */
  async setEnabled(actor: StaffActor, enabled: boolean): Promise<ReservationSettingsView> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const v = await tx.venue.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { reservationsCode: true } });
          await tx.venue.update({
            where: { id: actor.tenantId },
            data: { reservationsEnabled: enabled, ...(enabled && !v.reservationsCode ? { reservationsCode: newReservationsCode() } : {}) },
          });
        });
        break;
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002' || attempt >= MAX_CODE_ATTEMPTS) throw err;
      }
    }
    await this.audit.log({ action: 'reservations.enabled', tenantId: actor.tenantId, actorId: actor.userId, targetType: 'Venue', targetId: actor.tenantId, payload: { enabled } });
    return this.settings(actor.tenantId);
  }

  // ─── «Señales de reservas» ─────────────────────────────────────────

  /**
   * Contabilidad aparte de las ventas: lo cobrado de reservas, lo que pasó a
   * venta (al llegar, y las señales perdidas), lo que pasó a saldo (el importe
   * para consumir) y lo que se debe hoy a clientes que aún no han venido.
   * Noches de `from` a `to` (de 08:00 a 08:00 de Madrid).
   */
  async accounting(actor: StaffActor, from: string, to: string): Promise<ReservationAccounting & { toSaldoCents: number }> {
    if (!isRealDay(from) || !isRealDay(to) || from > to) throw new ConflictException('Fechas no válidas');
    const start = madridAt(from, NIGHT_CUTOFF_HOUR);
    const end = madridAt(nextDay(to), NIGHT_CUTOFF_HOUR);
    const rows = await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.$queryRaw<Array<{ collected: bigint; recognized: bigint; toSaldo: bigint; outstanding: bigint; commission: bigint }>>`
        SELECT
          (SELECT COALESCE(SUM(rp."amountCents"), 0) FROM reservation_payments rp
            WHERE rp."tenantId" = ${actor.tenantId}::uuid AND rp."paidAt" >= ${start} AND rp."paidAt" < ${end}) AS collected,
          (SELECT COALESCE(SUM(CASE WHEN r.status = 'ARRIVED' THEN r."priceCents" - r."creditCents"
                                    ELSE LEAST(r."depositCents", r."paidCents") END), 0)
             FROM reservations r
            WHERE r."tenantId" = ${actor.tenantId}::uuid AND r.status IN ('ARRIVED', 'NO_SHOW', 'CLIENT_CANCELED')
              AND r."recognizedAt" >= ${start} AND r."recognizedAt" < ${end}) AS recognized,
          (SELECT COALESCE(SUM(CASE WHEN r.status = 'ARRIVED' THEN r."creditCents"
                                    ELSE r."paidCents" - LEAST(r."depositCents", r."paidCents") END), 0)
             FROM reservations r
            WHERE r."tenantId" = ${actor.tenantId}::uuid AND r.status IN ('ARRIVED', 'NO_SHOW', 'CLIENT_CANCELED')
              AND r."recognizedAt" >= ${start} AND r."recognizedAt" < ${end}) AS "toSaldo",
          (SELECT COALESCE(SUM(r."paidCents"), 0) FROM reservations r
            WHERE r."tenantId" = ${actor.tenantId}::uuid AND r.status IN ('DEPOSIT_PAID', 'PAID')) AS outstanding,
          (SELECT COALESCE(SUM(e."commissionCents" - e."reversedCents"), 0) FROM operator_earnings e
             JOIN reservation_payments rp ON rp."paymentId" = e."paymentId"
            WHERE e."tenantId" = ${actor.tenantId}::uuid AND e."createdAt" >= ${start} AND e."createdAt" < ${end}) AS commission
      `,
    );
    const r = rows[0];
    return {
      from,
      to,
      collectedCents: Number(r?.collected ?? 0),
      recognizedCents: Number(r?.recognized ?? 0),
      toSaldoCents: Number(r?.toSaldo ?? 0),
      outstandingCents: Number(r?.outstanding ?? 0),
      promoterCommissionCents: Number(r?.commission ?? 0),
    };
  }
}

function packageData(dto: ReservationPackageInput) {
  return {
    name: dto.name,
    kind: dto.kind,
    priceCents: dto.priceCents,
    creditCents: dto.kind === 'ITEMS' ? 0 : dto.creditCents,
    entries: dto.entries,
    items: dto.items,
    description: dto.description ?? null,
    maxPerNight: dto.maxPerNight ?? null,
    ...(dto.active !== undefined ? { active: dto.active } : {}),
  };
}

export function originOf(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}
