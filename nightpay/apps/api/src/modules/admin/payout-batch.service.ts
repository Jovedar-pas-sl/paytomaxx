import {
  PAYOUT_BATCH_CHANGED,
  PAYOUT_BATCH_CHANGED_MESSAGE,
  PAYOUT_BATCH_NEEDS_APPROVAL,
  PAYOUT_BATCH_NEEDS_APPROVAL_MESSAGE,
  PAYOUT_BATCH_PROBLEM_CODES,
  stepUpActions,
  type CreatePayoutBatchDto,
  type PayoutBatchItemResult,
  type PayoutBatchProblem,
  type PayoutBatchProblemCode,
  type PayoutBatchResult,
  type Role,
} from '@nightpay/contracts';
import { ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService, type TransactionalClient } from '../../common/prisma/prisma.service';
import { ApprovalRequestsService } from '../approvals/approval-requests.service';
import { isLastingFailure } from '../approvals/approval-rules';
import { assertNoPendingPayout, pendingPayoutRequest } from '../approvals/approval-store';
import { AuditService } from '../audit/audit.service';
import { TotpService } from '../auth/totp.service';
import { payoutHolderNotConfirmed } from '../operators/alta-identity';
import { OperatorsService } from '../operators/operators.service';
import { PAYEE_ROLES } from '../operators/payee-roles';
import { payoutAccountTooNew } from '../operators/payout-account-notices';
import type { PayoutIdempotency } from '../operators/payout-idempotency';
import { idempotencyHashOf } from '../payments/idempotency';

/** A quien no tiene 2FA ni llave de acceso (también al dueño que paga una a una sin código). */
export const PAYOUT_BATCH_2FA_MESSAGE =
  'Para pagar a varias a la vez hace falta la verificación en dos pasos o una llave de acceso (Ajustes → Seguridad). Mientras, págales una a una.';

export interface PayoutBatchActor {
  userId: string;
  role: Role;
  tenantId: string;
}

type Item = CreatePayoutBatchDto['items'][number];

/** Lo que se mira de cada persona, antes de pagar y otra vez dentro de su pago. Sin la cuenta en claro. */
const PERSON_SELECT = {
  id: true,
  displayName: true,
  payoutMethod: true,
  payoutAddress: true,
  payoutHoldUntil: true,
  payoutMetadata: true,
  legalName: true,
  payoutHolderConfirmedAt: true,
} as const;

interface PersonRow {
  id: string;
  displayName: string | null;
  payoutMethod: string | null;
  payoutAddress: string | null;
  payoutHoldUntil: Date | null;
  payoutMetadata: unknown;
  legalName: string | null;
  payoutHolderConfirmedAt: Date | null;
}

const KNOWN_CODES: ReadonlySet<string> = new Set(PAYOUT_BATCH_PROBLEM_CODES);

function bodyOf(err: HttpException): Record<string, unknown> {
  const body = err.getResponse();
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

function problem(code: PayoutBatchProblemCode, message: string): ConflictException {
  return new ConflictException({ message, code });
}

/** En una tanda no se paga en efectivo ni a quien no tiene cuenta: eso, una a una. */
function accountProblem(person: Pick<PersonRow, 'payoutMethod' | 'payoutAddress'>): ConflictException | null {
  if (person.payoutMethod === 'MANUAL_CASH') return problem('CASH', 'Cobra en efectivo: págale aparte.');
  if (!person.payoutMethod || !person.payoutAddress?.trim()) return problem('NO_ACCOUNT', 'No tiene cuenta de cobro: págale aparte.');
  return null;
}

/**
 * Lo que impide pagarle a su cuenta, con lo guardado ahora: sin cuenta o en
 * efectivo, cuenta cambiada hace menos de 48 h, o titular sin confirmar.
 */
function personProblem(person: PersonRow, now: Date): ConflictException | null {
  return (
    accountProblem(person) ??
    payoutAccountTooNew(person, person.payoutMethod, now) ??
    payoutHolderNotConfirmed(person, person.payoutMethod)
  );
}

/**
 * Un error «de las cosas» (isLastingFailure) como fila: su código de siempre
 * si lo lleva; un 404 → NOT_FOUND; un 409 sin código → NOTHING_TO_PAY (el
 * «no hay nada que liquidar» de createPayout); cualquier otro → OTHER.
 */
function failureOf(err: HttpException): Pick<PayoutBatchItemResult, 'code' | 'totalCents' | 'payableFrom'> {
  const body = bodyOf(err);
  const raw = typeof body.code === 'string' ? body.code : null;
  const code: PayoutBatchProblemCode =
    err.getStatus() === 404
      ? 'NOT_FOUND'
      : raw === null
        ? err.getStatus() === 409
          ? 'NOTHING_TO_PAY'
          : 'OTHER'
        : KNOWN_CODES.has(raw) && raw !== 'UNKNOWN' && raw !== 'SKIPPED'
          ? (raw as PayoutBatchProblemCode)
          : 'OTHER';
  return {
    code,
    ...(typeof body.totalCents === 'number' && Number.isInteger(body.totalCents) ? { totalCents: body.totalCents } : {}),
    ...(typeof body.payableFrom === 'string' ? { payableFrom: body.payableFrom } : {}),
  };
}

/**
 * «Pagar» a varias a la vez: UNA petición y UN segundo factor; dentro, un pago
 * por persona, cada uno en su transacción (OperatorsService.createPayout, con
 * su candado): el que falla no deshace los buenos. No manda dinero: apunta
 * pagos ya hechos fuera, liquida sus comisiones y avisa a cada una.
 *
 * El cuerpo solo dice a quién y la cifra que se vio: el importe, el método y
 * la cuenta salen de lo guardado, leído con el candado de cada persona tomado.
 */
@Injectable()
export class PayoutBatchService {
  private readonly logger = new Logger(PayoutBatchService.name);
  private readonly prisma: PrismaService;
  private readonly operators: OperatorsService;
  private readonly approvals: ApprovalRequestsService;
  private readonly totp: TotpService;
  private readonly audit: AuditService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(OperatorsService) operators: OperatorsService,
    @Inject(ApprovalRequestsService) approvals: ApprovalRequestsService,
    @Inject(TotpService) totp: TotpService,
    @Inject(AuditService) audit: AuditService,
  ) {
    this.prisma = prisma;
    this.operators = operators;
    this.approvals = approvals;
    this.totp = totp;
    this.audit = audit;
  }

  async pay(actor: PayoutBatchActor, key: string, dto: CreatePayoutBatchDto): Promise<PayoutBatchResult> {
    const { tenantId, userId } = actor;
    // 1. Quién: como el pago de una en una. Quien tiene que pedirlo al dueño no paga aquí.
    const route = await this.approvals.payoutRouteFor(actor);
    if (route.kind === 'forbidden') throw new ForbiddenException('Solo el dueño o el encargado pagan a las chicas');
    if (route.kind === 'request') {
      throw new ConflictException({ message: PAYOUT_BATCH_NEEDS_APPROVAL_MESSAGE, code: PAYOUT_BATCH_NEEDS_APPROVAL });
    }

    // 2. La misma clave otra vez: lo ya apuntado vuelve tal cual (sin aviso ni
    //    registro nuevos). Con otra cifra para alguien, 409 IDEMPOTENCY_KEY_REUSED
    //    (lo lanza findPayoutReplay) antes de gastar el código o pagar a nadie.
    const idempotencyOf = (item: Item): PayoutIdempotency => ({
      key: `${key}:${item.operatorId}`,
      // Sin el código 2FA (cambia cada 30 s), como payoutRequestHash.
      hash: idempotencyHashOf(userId, { batch: true, operatorId: item.operatorId, expectedTotalCents: item.expectedTotalCents }),
    });
    const results = new Map<string, PayoutBatchItemResult>();
    const replayed = new Set<string>();
    for (const item of dto.items) {
      const prior = await this.operators.findPayoutReplay(tenantId, item.operatorId, userId, idempotencyOf(item));
      if (!prior) continue;
      results.set(item.operatorId, { operatorId: item.operatorId, status: 'PAID', payoutId: prior.id, totalCents: prior.totalCents });
      replayed.add(item.operatorId);
    }
    const todo = dto.items.filter((item) => !replayed.has(item.operatorId));
    if (todo.length === 0) return this.resultOf(dto.items, results);

    // 3. Comprobación en seco de las demás, sin tocar nada: si a alguna no se le
    //    puede pagar tal como se vio, no se paga a nadie y el código no se gasta.
    const problems = await this.dryCheck(tenantId, todo);
    if (problems.length > 0) {
      throw new ConflictException({ message: PAYOUT_BATCH_CHANGED_MESSAGE, code: PAYOUT_BATCH_CHANGED, problems });
    }

    // 4. El segundo factor, una vez para todas y ANTES del primer pago: atado a
    //    la clave, a cuántas son y al total de la petición. Aquí siempre hace
    //    falta (2FA o la prueba de la llave), también para el dueño.
    const sumCents = dto.items.reduce((sum, item) => sum + item.expectedTotalCents, 0);
    await this.totp.assertForUser(userId, dto.totpCode, stepUpActions.payoutBatch(key, dto.items.length, sumCents), PAYOUT_BATCH_2FA_MESSAGE);

    // 5. Una a una, en serie. Un fallo «de las cosas» (ya pagada, otra cifra…)
    //    es de esa persona y se sigue; uno inesperado (la base…) para la tanda:
    //    de esa no se sabe y las siguientes no se intentan.
    let stopped = false;
    for (const item of todo) {
      const { operatorId } = item;
      if (stopped) {
        results.set(operatorId, { operatorId, status: 'SKIPPED', code: 'SKIPPED' });
        continue;
      }
      try {
        const payout = await this.operators.createPayout(tenantId, operatorId, userId, undefined, {
          expectedTotalCents: item.expectedTotalCents,
          idempotency: idempotencyOf(item),
          batchKey: key,
          inTransaction: (tx) => this.recheckInTransaction(tx, tenantId, operatorId),
        });
        results.set(operatorId, { operatorId, status: 'PAID', payoutId: payout.id, totalCents: payout.totalCents });
      } catch (err) {
        if (isLastingFailure(err)) {
          results.set(operatorId, { operatorId, status: 'FAILED', ...failureOf(err) });
          continue;
        }
        this.logger.error(`Tanda ${key}: fallo inesperado al pagar a ${operatorId}: ${(err as Error)?.message ?? String(err)}`);
        results.set(operatorId, { operatorId, status: 'FAILED', code: 'UNKNOWN' });
        stopped = true;
      }
    }

    // 6. El registro de la tanda (cada pago nuevo ya dejó el suyo). Sin cuentas.
    const result = this.resultOf(dto.items, results);
    await this.audit.log({
      action: 'operator.payout.batch',
      tenantId,
      actorId: userId,
      targetType: 'Venue',
      targetId: tenantId,
      payload: {
        batchKey: key,
        count: dto.items.length,
        paidCount: result.paidCount,
        paidCents: result.paidCents,
        results: result.results.map((r) => ({
          operatorId: r.operatorId,
          status: r.status,
          ...(r.status === 'PAID' ? { payoutId: r.payoutId } : { code: r.code }),
          ...(replayed.has(r.operatorId) ? { replayed: true } : {}),
        })),
      },
    });
    return result;
  }

  /** Las filas en el orden pedido y lo pagado (lo de ahora y lo ya apuntado con esta clave). */
  private resultOf(items: readonly Item[], byOperator: ReadonlyMap<string, PayoutBatchItemResult>): PayoutBatchResult {
    const results = items.map((item) => byOperator.get(item.operatorId)!);
    const paid = results.filter((r) => r.status === 'PAID');
    return { results, paidCount: paid.length, paidCents: paid.reduce((sum, r) => sum + (r.totalCents ?? 0), 0) };
  }

  /**
   * Sin tocar nada: cada persona tiene que ser del local (y no estar de baja:
   * si no, NOT_FOUND, igual que si no existiera), cobrar por una cuenta (no en
   * efectivo), sin espera de 48 h, con el titular confirmado, sin una petición
   * «Por aprobar» pendiente y con lo pagable igual a la cifra que se vio.
   */
  private async dryCheck(tenantId: string, items: readonly Item[]): Promise<PayoutBatchProblem[]> {
    const now = new Date();
    const { people, pending } = await this.prisma.withTenant(tenantId, async (tx) => {
      const rows: PersonRow[] = await tx.user.findMany({
        where: { id: { in: items.map((item) => item.operatorId) }, tenantId, role: { in: [...PAYEE_ROLES] }, deletedAt: null },
        select: PERSON_SELECT,
      });
      const found = new Map(rows.map((row) => [row.id, row]));
      const withRequest = new Set<string>();
      for (const row of rows) {
        if (await pendingPayoutRequest(tx, tenantId, row.id, now)) withRequest.add(row.id);
      }
      return { people: found, pending: withRequest };
    });

    const problems: PayoutBatchProblem[] = [];
    for (const { operatorId, expectedTotalCents } of items) {
      const person = people.get(operatorId);
      if (!person) {
        problems.push({ operatorId, code: 'NOT_FOUND' });
        continue;
      }
      const blocked = personProblem(person, now);
      if (blocked) {
        problems.push({ operatorId, ...(failureOf(blocked) as { code: PayoutBatchProblemCode }) });
        continue;
      }
      if (pending.has(operatorId)) {
        problems.push({ operatorId, code: 'APPROVAL_ALREADY_PENDING' });
        continue;
      }
      const { availableCents } = await this.operators.getBalance(operatorId, tenantId);
      if (availableCents !== expectedTotalCents) {
        problems.push({ operatorId, code: availableCents > 0 ? 'PAYOUT_CHANGED' : 'NOTHING_TO_PAY', totalCents: availableCents });
      }
    }
    return problems;
  }

  /**
   * Dentro de la transacción del pago, con el candado de la persona tomado y
   * antes de leer sus comisiones: lo mismo que la comprobación en seco, con lo
   * de ahora (una petición, una baja o un cambio de cuenta pudieron entrar
   * mientras). Si algo no cuadra, ese pago no se apunta.
   */
  private async recheckInTransaction(tx: TransactionalClient, tenantId: string, operatorId: string): Promise<void> {
    await assertNoPendingPayout(tx, tenantId, operatorId);
    const person: PersonRow | null = await tx.user.findFirst({
      where: { id: operatorId, tenantId, role: { in: [...PAYEE_ROLES] }, deletedAt: null },
      select: PERSON_SELECT,
    });
    if (!person) throw new NotFoundException('Operadora no encontrada');
    const blocked = personProblem(person, new Date());
    if (blocked) throw blocked;
  }
}
