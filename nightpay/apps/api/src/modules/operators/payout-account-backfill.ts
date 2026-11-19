import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Prisma } from '@nightpay/db';
import { reportError } from '../../common/observability/sentry';
import { PrismaService } from '../../common/prisma/prisma.service';
import { openPayoutAccount, sealLegacyPayoutAccount, type StoredPayoutAccount } from './payout-account';
import { openPayoutValue, sealPayoutValue } from './payout-account-crypto';

/**
 * El relleno de «cuenta de cobro segura» (migración 20261119100000): cifra las
 * cuentas de cobro y los titulares que estaban en claro (users) y la cuenta
 * guardada en cada pago ya hecho (operator_payouts.paidToAddress).
 *
 * Se lanza solo cada vez que arranca el API, después de las migraciones: al
 * publicar no hay que hacer nada a mano. Va por detrás: el arranque no lo
 * espera (mientras, el API lee las dos formas). Se puede repetir las veces
 * que haga falta: lo ya cifrado no se toca. Cada fila se cambia solo si sigue
 * como se leyó (si alguien la cambia a la vez, se deja y entra en la
 * siguiente). Nunca impide arrancar. Al acabar cuenta lo que sigue en claro:
 * si queda algo (o si no termina), error en el log y a Sentry. No es un
 * cambio de cuenta: ni avisos, ni espera, ni `updatedAt`.
 */
export interface PayoutBackfillResult {
  /** Personas con la cuenta (o el titular) recién cifrada. */
  accounts: number;
  /** Pagos con su cuenta recién cifrada. */
  payouts: number;
  /** Filas que no se pudieron cifrar (siguen en claro). */
  failed: number;
}

type AccountRow = StoredPayoutAccount;
interface PayoutRow {
  id: string;
  operatorId: string;
  paidToAddress: string;
}

const PAGE = 200;
const FIRST_ID = '00000000-0000-0000-0000-000000000000';

/** Una persona (users) con la cuenta o el titular todavía en claro. */
const ACCOUNT_IN_CLEAR = Prisma.sql`((btrim(COALESCE("payoutAddress", '')) <> '' AND "payoutAddress" NOT LIKE 'pa1:%')
  OR (btrim(COALESCE("payoutMetadata" ->> 'accountHolder', '')) <> '' AND "payoutMetadata" ->> 'accountHolder' NOT LIKE 'pa1:%'))`;
/** Un pago (operator_payouts) con su cuenta todavía en claro. */
const PAYOUT_IN_CLEAR = Prisma.sql`(btrim(COALESCE("paidToAddress", '')) <> '' AND "paidToAddress" NOT LIKE 'pa1:%')`;

/** Para el log. De un fallo de la base, solo su tipo y su código: su mensaje podría llevar la cuenta. */
export function reasonOf(err: unknown): string {
  if (!(err instanceof Error)) return 'error desconocido';
  if (!err.name.startsWith('PrismaClient')) return err.message;
  return `${err.name} ${(err as { code?: string }).code ?? ''}`.trim();
}

@Injectable()
export class PayoutAccountBackfill implements OnApplicationBootstrap {
  private readonly logger = new Logger(PayoutAccountBackfill.name);
  private readonly prisma: PrismaService;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  onApplicationBootstrap(): void {
    void this.runLogged();
  }

  /**
   * El relleno entero y, al acabar, cómo ha quedado: «ninguna en claro» o, si
   * queda alguna (no se pudo cifrar, o la guardó el API anterior mientras se
   * publicaba), un error que se oiga. Nunca lanza.
   */
  async runLogged(): Promise<void> {
    try {
      const done = await this.run();
      if (done.accounts + done.payouts + done.failed > 0) {
        this.logger.log(`Cuentas de cobro cifradas: ${done.accounts} personas y ${done.payouts} pagos (${done.failed} sin poder)`);
      }
      const left = await this.leftInClear();
      if (left === 0) {
        this.logger.log('Cuentas de cobro: ninguna en claro');
      } else {
        this.alarm(
          `Cuentas de cobro EN CLARO tras el relleno: ${left} (personas y pagos). No se pudieron cifrar (¿falta ENCRYPTION_KEK?) ` +
            'o las guardó el API anterior mientras se publicaba: reinicia el API para repetirlo (docs/CUENTA-COBRO-SEGURA.md)',
        );
      }
    } catch (err) {
      this.alarm(`El relleno de las cuentas de cobro no ha terminado (se repite al arrancar): ${reasonOf(err)}`);
    }
  }

  /** Al log como error y a Sentry (si está puesto). Solo números y el tipo del fallo: nunca una cuenta. */
  private alarm(message: string): void {
    this.logger.error(message);
    reportError(new Error(message), { tag: 'payout-account-backfill' });
  }

  /** Cuántas personas y pagos tienen todavía la cuenta (o el titular) en claro. */
  async leftInClear(): Promise<number> {
    const rows = await this.prisma.asSystem((tx) => tx.$queryRaw<Array<{ n: number }>>`
      SELECT ((SELECT count(*) FROM users WHERE ${ACCOUNT_IN_CLEAR})
            + (SELECT count(*) FROM operator_payouts WHERE ${PAYOUT_IN_CLEAR}))::int AS n
    `);
    return rows[0]?.n ?? 0;
  }

  async run(kek: string | undefined = process.env.ENCRYPTION_KEK): Promise<PayoutBackfillResult> {
    const result: PayoutBackfillResult = { accounts: 0, payouts: 0, failed: 0 };
    for (let after = FIRST_ID, page: AccountRow[] = []; (page = await this.accountsInClear(after)).length > 0; ) {
      for (const row of page) await this.count(result, 'accounts', () => this.sealAccount(row, kek));
      after = page[page.length - 1]!.id;
    }
    for (let after = FIRST_ID, page: PayoutRow[] = []; (page = await this.payoutsInClear(after)).length > 0; ) {
      for (const row of page) await this.count(result, 'payouts', () => this.sealPayout(row, kek));
      after = page[page.length - 1]!.id;
    }
    return result;
  }

  /** Una fila que falla no para las demás (ni se apunta su cuenta en el log). */
  private async count(result: PayoutBackfillResult, key: 'accounts' | 'payouts', seal: () => Promise<boolean>): Promise<void> {
    try {
      if (await seal()) result[key] += 1;
    } catch (err) {
      result.failed += 1;
      this.logger.error(`No se pudo cifrar una cuenta de cobro (${key}): ${reasonOf(err)}`);
    }
  }

  private accountsInClear(after: string): Promise<AccountRow[]> {
    return this.prisma.asSystem((tx) => tx.$queryRaw<AccountRow[]>`
      SELECT id, "payoutMethod", "payoutAddress", "payoutMetadata", "payoutLabel", "payoutAddressMasked", "payoutHolderMasked"
        FROM users
       WHERE id > ${after}::uuid
         AND ${ACCOUNT_IN_CLEAR}
       ORDER BY id
       LIMIT ${PAGE}
    `);
  }

  private async sealAccount(row: AccountRow, kek: string | undefined): Promise<boolean> {
    const data = sealLegacyPayoutAccount(row, kek);
    if (!data) return false;
    const sealed = { ...row, ...data } as StoredPayoutAccount;
    // Antes de escribir: lo cifrado se abre y es lo mismo que había.
    if (JSON.stringify(openPayoutAccount(sealed, kek)) !== JSON.stringify(openPayoutAccount(row, kek))) {
      throw new Error('lo cifrado no coincide con lo que había');
    }
    const before = row.payoutMetadata === null ? null : JSON.stringify(row.payoutMetadata);
    const meta = sealed.payoutMetadata === null ? null : JSON.stringify(sealed.payoutMetadata);
    const changed = await this.prisma.asSystem((tx) => tx.$executeRaw`
      UPDATE users
         SET "payoutAddress" = ${sealed.payoutAddress},
             "payoutAddressMasked" = ${sealed.payoutAddressMasked ?? null},
             "payoutMetadata" = ${meta}::jsonb,
             "payoutHolderMasked" = ${sealed.payoutHolderMasked ?? null}
       WHERE id = ${row.id}::uuid
         AND "payoutAddress" IS NOT DISTINCT FROM ${row.payoutAddress}
         AND "payoutMetadata" IS NOT DISTINCT FROM ${before}::jsonb
    `);
    return changed === 1;
  }

  private payoutsInClear(after: string): Promise<PayoutRow[]> {
    return this.prisma.asSystem((tx) => tx.$queryRaw<PayoutRow[]>`
      SELECT id, "operatorId", "paidToAddress"
        FROM operator_payouts
       WHERE id > ${after}::uuid
         AND ${PAYOUT_IN_CLEAR}
       ORDER BY id
       LIMIT ${PAGE}
    `);
  }

  /** La cuenta a la que se pagó, cifrada como la de la persona (así la abre la verificación on-chain). */
  private async sealPayout(row: PayoutRow, kek: string | undefined): Promise<boolean> {
    const ref = { userId: row.operatorId, field: 'address' as const };
    const sealed = sealPayoutValue(row.paidToAddress, ref, kek);
    if (openPayoutValue(sealed, ref, kek) !== row.paidToAddress) throw new Error('lo cifrado no coincide con lo que había');
    const changed = await this.prisma.asSystem((tx) => tx.$executeRaw`
      UPDATE operator_payouts SET "paidToAddress" = ${sealed}
       WHERE id = ${row.id}::uuid AND "paidToAddress" = ${row.paidToAddress}
    `);
    return changed === 1;
  }
}
