import { describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
import {
  CLIENT_BITCOIN_CONFIRMING,
  REST_PAYING_TEXT,
  VENUE_BITCOIN_CONFIRMING,
  bitcoinConfirming,
  conflictCode,
  restPayingText,
} from './reservation-open-payments';

const conflict = (code: string) => new ConflictException({ code, message: 'x' });

describe('el pago a medias de un reservado: lo que se dice si aún no se puede cancelar', () => {
  it('el código de un 409 de negocio; sin código u otro error, null', () => {
    expect(conflictCode(conflict('BITCOIN_CONFIRMING'))).toBe('BITCOIN_CONFIRMING');
    expect(conflictCode(new ConflictException('Payment cannot be canceled in state AUTHORIZED'))).toBeNull();
    expect(conflictCode(new Error('x'))).toBeNull();
    expect(conflictCode(null)).toBeNull();
  });

  it('el resto en efectivo: con el bitcoin en la red o el cliente en su banco, la frase para el personal; con otro error, null', () => {
    expect(restPayingText(conflict('BITCOIN_CONFIRMING'))).toBe(
      'El cliente ya pagó el resto con bitcoin y falta que la red lo confirme: no cobres en efectivo. Espera unos minutos.',
    );
    expect(restPayingText(conflict('CANCEL_AT_BANK_TOO_SOON'))).toBe(
      'El cliente está pagando el resto en su banco: no cobres en efectivo. Si en 2 minutos no responde, ya podrás.',
    );
    expect(restPayingText(conflict('OTRO'))).toBeNull();
    expect(restPayingText(new ConflictException('Payment cannot be canceled in state AUTHORIZED'))).toBeNull();
  });

  it('anular con el bitcoin en la red: el mismo código, con el texto de quien anula', () => {
    expect(bitcoinConfirming(CLIENT_BITCOIN_CONFIRMING).getResponse()).toEqual({ code: 'BITCOIN_CONFIRMING', message: CLIENT_BITCOIN_CONFIRMING });
    expect(CLIENT_BITCOIN_CONFIRMING).toMatch(/^Tu pago con bitcoin/);
    expect(VENUE_BITCOIN_CONFIRMING).toMatch(/^El cliente ya pagó con bitcoin/);
  });

  it('frases de menos de 120 letras: la app del personal no enseña un 409 más largo', () => {
    const texts = [
      CLIENT_BITCOIN_CONFIRMING,
      VENUE_BITCOIN_CONFIRMING,
      REST_PAYING_TEXT,
      restPayingText(conflict('BITCOIN_CONFIRMING')),
      restPayingText(conflict('CANCEL_AT_BANK_TOO_SOON')),
    ];
    for (const t of texts) expect(t!.length).toBeLessThan(120);
  });
});
