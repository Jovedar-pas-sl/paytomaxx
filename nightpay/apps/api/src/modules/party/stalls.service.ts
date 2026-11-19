import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import {
  NO_STALL_CODE,
  NO_STALL_MESSAGE,
  STALL_BPS_LOCKED_CODE,
  STALL_BPS_LOCKED_MESSAGE,
  STALL_STAFF_ROLES,
  isEventEnded,
  stallChangeTouchesMoney,
  type AssignStallDto,
  type CreateStallDto,
  type JwtPayload,
  type MyStall,
  type StallStaffPerson,
  type StallView,
  type UpdateStallDto,
} from '@nightpay/contracts';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TotpService } from '../auth/totp.service';
import { STALL_SELECT, stallAudit, stallChange, stallCreateData, stallView } from './stall-views';

/** Una caseta con cobros o consumos no se borra: se desactiva. */
export const STALL_IN_USE_CODE = 'STALL_IN_USE';
const STALL_IN_USE_MESSAGE = 'Esta caseta ya tiene cobros: desactívala en vez de borrarla.';
const STALL_NOT_FOUND = 'Esa caseta no es de este local';
const PERSON_NOT_FOUND = 'Esa persona no es del personal de este local';

const STAFF_SELECT = { id: true, email: true, displayName: true, role: true, stallId: true } as const;
const WITH_STAFF_COUNT = { ...STALL_SELECT, _count: { select: { staff: { where: { deletedAt: null } } } } } as const;
const MY_STALL_SELECT = { id: true, name: true, openNow: true } as const;

/**
 * Casetas de OxioParty (stalls, FORCE RLS: siempre dentro de withTenant) y el
 * personal de cada una. La parte del organizador y el IBAN son dinero: con la
 * 2FA activada, cambiarlos pide el código (como las reglas del local). Con la
 * fiesta terminada, la parte del organizador ya no cambia (409
 * STALL_BPS_LOCKED: el cierre queda fijo); lo demás, sí. Todo cambio queda en
 * el registro, con el IBAN tapado.
 */
@Injectable()
export class StallsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TotpService) private readonly totp: TotpService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(tenantId: string): Promise<StallView[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.stall.findMany({ where: { tenantId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: WITH_STAFF_COUNT }),
    );
    return rows.map(stallView);
  }

  async create(actor: JwtPayload, dto: CreateStallDto): Promise<StallView> {
    // La parte del organizador siempre va: es dinero.
    await this.totp.assertIfEnrolledForUser(actor.sub, dto.totpCode);
    const data = stallCreateData(actor.tenantId, dto);
    const row = await this.prisma.withTenant(actor.tenantId, (tx) => tx.stall.create({ data, select: WITH_STAFF_COUNT }));
    await this.log(actor, 'party.stall.created', row.id, { after: stallAudit(row) });
    return stallView(row);
  }

  async update(actor: JwtPayload, id: string, dto: UpdateStallDto): Promise<StallView> {
    const current = await this.findOrThrow(actor.tenantId, id);
    const change = stallChange(current, dto);
    if (Object.keys(change).length === 0) return stallView(current);
    // Antes de la 2FA: no se pide el código para algo que no se va a guardar.
    if (change.organizerBps !== undefined) await this.assertBpsUnlocked(actor.tenantId);
    if (stallChangeTouchesMoney(change)) await this.totp.assertIfEnrolledForUser(actor.sub, dto.totpCode);
    const row = await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.stall.update({ where: { id }, data: change, select: WITH_STAFF_COUNT }),
    );
    const before = Object.fromEntries(Object.keys(change).map((k) => [k, current[k as keyof typeof change]]));
    await this.log(actor, 'party.stall.updated', id, { before: stallAudit(before), after: stallAudit(change) });
    return stallView(row);
  }

  /**
   * Borra una caseta sin cobros ni consumos (su personal se queda sin caseta,
   * en la misma transacción). Con alguno, 409 STALL_IN_USE: se desactiva.
   */
  async remove(actor: JwtPayload, id: string): Promise<{ deleted: true; unassignedStaff: number }> {
    let unassignedStaff: number;
    let name: string;
    try {
      ({ unassignedStaff, name } = await this.prisma.withTenant(actor.tenantId, async (tx) => {
        const stall = await tx.stall.findFirst({ where: { id, tenantId: actor.tenantId }, select: { name: true } });
        if (!stall) throw new NotFoundException(STALL_NOT_FOUND);
        const { count } = await tx.user.updateMany({ where: { tenantId: actor.tenantId, stallId: id }, data: { stallId: null } });
        await tx.stall.delete({ where: { id } });
        return { unassignedStaff: count, name: stall.name };
      }));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        throw new ConflictException({ message: STALL_IN_USE_MESSAGE, code: STALL_IN_USE_CODE });
      }
      throw err;
    }
    await this.log(actor, 'party.stall.deleted', id, { name, unassignedStaff });
    return { deleted: true, unassignedStaff };
  }

  // ─── El personal y su caseta ────────────────────────────────────────

  async staff(tenantId: string): Promise<StallStaffPerson[]> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.user.findMany({
        where: { tenantId, deletedAt: null, role: { in: [...STALL_STAFF_ROLES] } },
        select: STAFF_SELECT,
        orderBy: [{ role: 'asc' }, { displayName: 'asc' }, { email: 'asc' }],
      }),
    );
  }

  /** Cambia la caseta de una persona del personal (null = sin caseta). Solo a una caseta activa del local. */
  async assign(actor: JwtPayload, userId: string, dto: AssignStallDto): Promise<StallStaffPerson> {
    const tenantId = actor.tenantId;
    const { before, person } = await this.prisma.withTenant(tenantId, async (tx) => {
      const found = await tx.user.findFirst({
        where: { id: userId, tenantId, deletedAt: null, role: { in: [...STALL_STAFF_ROLES] } },
        select: { stallId: true },
      });
      if (!found) throw new NotFoundException(PERSON_NOT_FOUND);
      if (dto.stallId) {
        const stall = await tx.stall.findFirst({ where: { id: dto.stallId, tenantId }, select: { active: true } });
        if (!stall) throw new NotFoundException(STALL_NOT_FOUND);
        if (!stall.active) throw new ConflictException('Esa caseta está desactivada: actívala antes de darle personal.');
      }
      const updated = await tx.user.update({ where: { id: userId }, data: { stallId: dto.stallId }, select: STAFF_SELECT });
      return { before: found.stallId, person: updated };
    });
    if (before !== dto.stallId) {
      await this.log(actor, 'party.staff.stall_updated', userId, { before, after: dto.stallId }, 'User');
    }
    return person;
  }

  // ─── «Abierta ahora» desde la app del personal ──────────────────────

  /** La caseta (activa) de quien lo pide; null sin caseta. */
  async mine(actor: JwtPayload): Promise<MyStall | null> {
    return this.prisma.withTenant(actor.tenantId, (tx) => this.mineIn(tx, actor));
  }

  /**
   * Abrir o cerrar la suya y ninguna otra (la organización, cualquiera desde
   * el panel). Sin caseta, o con la suya archivada, 409 NO_STALL. Al registro.
   */
  async setMineOpen(actor: JwtPayload, openNow: boolean): Promise<MyStall> {
    const { stall, before } = await this.prisma.withTenant(actor.tenantId, async (tx) => {
      const current = await this.mineIn(tx, actor);
      if (!current) throw new ConflictException({ message: NO_STALL_MESSAGE, code: NO_STALL_CODE });
      if (current.openNow === openNow) return { stall: current, before: openNow };
      const updated = await tx.stall.update({ where: { id: current.id }, data: { openNow }, select: MY_STALL_SELECT });
      return { stall: updated, before: current.openNow };
    });
    if (before !== openNow) await this.log(actor, 'party.stall.open_changed', stall.id, { before, after: openNow });
    return stall;
  }

  // ─── internos ──────────────────────────────────────────────────────

  private async mineIn(tx: TransactionalClient, actor: JwtPayload): Promise<MyStall | null> {
    const me = await tx.user.findFirst({ where: { id: actor.sub, tenantId: actor.tenantId, deletedAt: null }, select: { stallId: true } });
    if (!me?.stallId) return null;
    return tx.stall.findFirst({ where: { id: me.stallId, tenantId: actor.tenantId, active: true }, select: MY_STALL_SELECT });
  }

  /** Con la fiesta terminada (eventEndsAt pasado), 409 STALL_BPS_LOCKED: el cierre ya no cambia. */
  private async assertBpsUnlocked(tenantId: string, now: Date = new Date()): Promise<void> {
    const venue = await this.prisma.asSystem((tx) => tx.venue.findUnique({ where: { id: tenantId }, select: { eventEndsAt: true } }));
    if (isEventEnded(venue?.eventEndsAt, now)) {
      throw new ConflictException({ message: STALL_BPS_LOCKED_MESSAGE, code: STALL_BPS_LOCKED_CODE });
    }
  }

  private async findOrThrow(tenantId: string, id: string) {
    const row = await this.prisma.withTenant(tenantId, (tx) => tx.stall.findFirst({ where: { id, tenantId }, select: WITH_STAFF_COUNT }));
    if (!row) throw new NotFoundException(STALL_NOT_FOUND);
    return row;
  }

  private async log(
    actor: JwtPayload,
    action: string,
    targetId: string,
    payload: Record<string, unknown>,
    targetType: 'Stall' | 'User' = 'Stall',
  ): Promise<void> {
    await this.audit.log({ action, tenantId: actor.tenantId, actorId: actor.sub, actorEmail: actor.email, targetType, targetId, payload });
  }
}
