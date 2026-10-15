import { BadRequestException } from '@nestjs/common';
import { normalizePayoutAddress, payoutAddressProblem, type PayoutMethod } from '@nightpay/contracts';

interface PayoutRouting {
  payoutMethod?: string | null;
  payoutAddress?: string | null;
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
