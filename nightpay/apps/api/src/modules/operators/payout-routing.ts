import { BadRequestException } from '@nestjs/common';
import { normalizePayoutAddress, payoutAddressProblem, type PayoutMethod } from '@nightpay/contracts';

interface PayoutRouting {
  payoutMethod?: string | null;
  payoutAddress?: string | null;
}

/** Los campos de la cuenta de cobro de una chica: a dónde va su dinero. */
export const PAYOUT_ACCOUNT_FIELDS = ['payoutMethod', 'payoutAddress', 'payoutMetadata', 'payoutLabel'] as const;

/** ¿El cambio toca la cuenta de cobro? (cambiarla pide 2FA y queda en el registro). */
export function touchesPayoutAccount(dto: Partial<Record<(typeof PAYOUT_ACCOUNT_FIELDS)[number], unknown>>): boolean {
  return PAYOUT_ACCOUNT_FIELDS.some((field) => dto[field] !== undefined);
}

/**
 * Campos de la cuenta de cobro a guardar tras un cambio. Si cambia el método
 * o la dirección, lo que QUEDA (lo nuevo + lo guardado) tiene que cuadrar:
 * cambiar solo el método dejando una dirección de otro método también es 400.
 * La dirección se guarda normalizada (IBAN en mayúsculas y sin espacios).
 */
export function payoutRoutingChanges(
  current: PayoutRouting,
  dto: { payoutMethod?: PayoutMethod | null; payoutAddress?: string | null },
): { payoutMethod?: PayoutMethod | null; payoutAddress?: string | null } {
  if (dto.payoutMethod === undefined && dto.payoutAddress === undefined) return {};
  const method = dto.payoutMethod !== undefined ? dto.payoutMethod : ((current.payoutMethod ?? null) as PayoutMethod | null);
  const address = dto.payoutAddress !== undefined ? dto.payoutAddress : (current.payoutAddress ?? null);
  const problem = payoutAddressProblem(method, address);
  if (problem) throw new BadRequestException(problem);
  return {
    ...(dto.payoutMethod !== undefined ? { payoutMethod: dto.payoutMethod } : {}),
    ...(dto.payoutAddress !== undefined
      ? { payoutAddress: dto.payoutAddress === null ? null : normalizePayoutAddress(method, dto.payoutAddress) }
      : {}),
  };
}
