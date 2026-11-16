import { ConflictException } from '@nestjs/common';

/**
 * Recarga cobrada en el datáfono (PAX) sin la prueba de Paytef
 * (PosDeviceService.holdUnproven): la tarjeta YA está cobrada y el saldo aún no
 * se ha sumado. Queda AUTHORIZING con la operación del datáfono hasta que la
 * resuelven en el panel (Resolver, admin.controller: la misma marca).
 *
 * Nadie del personal la cancela: cancelada, saldría de Incidencias («Recarga
 * del datáfono sin comprobar»), del cierre y de Resolver, con la tarjeta
 * cobrada y sin aviso del banco que lo recuerde (las ventas del lector no
 * tienen aviso).
 */
export function isHeldOnReader(p: { status: string; posOperationNumber?: string | null }): boolean {
  return p.status === 'AUTHORIZING' && Boolean(p.posOperationNumber);
}

/** El código del 409 al cancelar una recarga cobrada en el datáfono sin comprobar. */
export const CANCEL_HELD_ON_READER_CODE = 'CANCEL_HELD_ON_READER';

export const CANCEL_HELD_ON_READER_MESSAGE = 'Cobrado en el datáfono: lo resuelve el encargado en Pagos → Resolver';

export function heldOnReaderConflict(): ConflictException {
  return new ConflictException({ code: CANCEL_HELD_ON_READER_CODE, message: CANCEL_HELD_ON_READER_MESSAGE });
}
