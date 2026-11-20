import { NotFoundException, type CanActivate } from '@nestjs/common';
import { isPartyEdition } from '../../config/edition';

/**
 * Las rutas de OxioParty (casetas, ajustes de la fiesta) solo existen con
 * EDITION=party. Con OxioPay (club, por defecto) responden 404, como si no
 * estuvieran.
 */
export class PartyEditionGuard implements CanActivate {
  canActivate(): boolean {
    if (!isPartyEdition()) throw new NotFoundException();
    return true;
  }
}
