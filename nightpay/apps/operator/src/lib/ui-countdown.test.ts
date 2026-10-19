import { describe, expect, it } from 'vitest';
import {
  agoLabel,
  awaitingServerExpiry,
  clockTime,
  countdownPhase,
  effectiveStatus,
  formatClock,
  LOCAL_EXPIRY_GRACE_MS,
  outcomeKindOf,
  qrDeadline,
  remainingFraction,
  secondsLeft,
} from '@nightpay/ui';

const CREATED = '2026-10-15T22:00:00.000Z';
const EXPIRES = '2026-10-15T22:05:00.000Z';

describe('plazo del QR en el reloj del móvil', () => {
  it('dura lo que dijo el servidor desde que llegó la respuesta (reloj del móvil desfasado)', () => {
    // El móvil va 2 minutos adelantado: con la hora de caducar tal cual, quedarían 3 min.
    const receivedAt = Date.parse(CREATED) + 120_000;
    const d = qrDeadline(EXPIRES, receivedAt, CREATED)!;
    expect(d.endMs - d.startMs).toBe(300_000);
    expect(secondsLeft(d, receivedAt)).toBe(300);
  });

  it('sin hora de creación (cobro del saldo), la hora de caducar tal cual', () => {
    const now = Date.parse(CREATED);
    const d = qrDeadline(EXPIRES, now)!;
    expect(d).toEqual({ startMs: now, endMs: Date.parse(EXPIRES) });
  });

  it('fechas que no valen: sin cuenta atrás', () => {
    expect(qrDeadline('no-es-fecha', 0, CREATED)).toBeNull();
  });

  it('quedan segundos redondeando hacia arriba; nunca negativos', () => {
    const d = { startMs: 0, endMs: 10_000 };
    expect(secondsLeft(d, 0)).toBe(10);
    expect(secondsLeft(d, 9_001)).toBe(1);
    expect(secondsLeft(d, 10_000)).toBe(0);
    expect(secondsLeft(d, 99_000)).toBe(0);
  });

  it('la barra va de 1 a 0 sin salirse', () => {
    const d = { startMs: 1_000, endMs: 11_000 };
    expect(remainingFraction(d, 1_000)).toBe(1);
    expect(remainingFraction(d, 6_000)).toBe(0.5);
    expect(remainingFraction(d, 20_000)).toBe(0);
    expect(remainingFraction(d, 0)).toBe(1);
    expect(remainingFraction({ startMs: 5, endMs: 5 }, 0)).toBe(0);
  });

  it('ámbar en el último minuto, caducado a cero', () => {
    expect(countdownPhase(61)).toBe('ok');
    expect(countdownPhase(60)).toBe('ending');
    expect(countdownPhase(1)).toBe('ending');
    expect(countdownPhase(0)).toBe('over');
  });
});

describe('relojes en pantalla', () => {
  it('m:ss y, pasada la hora, h:mm:ss', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(12)).toBe('0:12');
    expect(formatClock(272)).toBe('4:32');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(-5)).toBe('0:00');
  });

  it('«hace 0:12» desde el resultado', () => {
    expect(agoLabel(1_000, 13_400)).toBe('hace 0:12');
    expect(agoLabel(5_000, 5_000)).toBe('hace 0:00');
  });
});

describe('estado que se enseña', () => {
  const d = { startMs: 0, endMs: 300_000 };

  it('un QR sin empezar a pagar caduca aquí pasado el margen, aunque el aviso no llegue', () => {
    expect(effectiveStatus('CREATED', d, 300_000)).toBe('CREATED');
    expect(effectiveStatus('CREATED', d, 300_000 + LOCAL_EXPIRY_GRACE_MS - 1)).toBe('CREATED');
    expect(effectiveStatus('CREATED', d, 300_000 + LOCAL_EXPIRY_GRACE_MS)).toBe('EXPIRED');
    expect(effectiveStatus('AWAITING_CAPTURE', d, 999_999)).toBe('EXPIRED');
  });

  it('pasado el plazo sin el «caducado» del servidor, se espera a que conteste', () => {
    expect(awaitingServerExpiry('CREATED', d, 300_000)).toBe(false);
    expect(awaitingServerExpiry('CREATED', d, 300_000 + LOCAL_EXPIRY_GRACE_MS)).toBe(true);
    expect(awaitingServerExpiry('AWAITING_CAPTURE', d, 999_999)).toBe(true);
    expect(awaitingServerExpiry('EXPIRED', d, 999_999)).toBe(false);
    expect(awaitingServerExpiry('AUTHORIZED', d, 999_999)).toBe(false);
    expect(awaitingServerExpiry('CREATED', null, 999_999)).toBe(false);
  });

  it('si el cliente ya está pagando (o ya terminó), manda el servidor', () => {
    expect(effectiveStatus('AUTHORIZING', d, 999_999)).toBe('AUTHORIZING');
    expect(effectiveStatus('AUTHORIZED', d, 999_999)).toBe('AUTHORIZED');
    expect(effectiveStatus('CREATED', null, 999_999)).toBe('CREATED');
  });

  it('resultado a pantalla completa: pagado, rechazado o caducado; lo demás no', () => {
    expect(outcomeKindOf('AUTHORIZED')).toBe('paid');
    expect(outcomeKindOf('FAILED')).toBe('failed');
    expect(outcomeKindOf('EXPIRED')).toBe('expired');
    for (const s of ['CREATED', 'AWAITING_CAPTURE', 'AUTHORIZING', 'ORPHAN', 'CANCELED', 'REFUNDED'] as const) {
      expect(outcomeKindOf(s)).toBeNull();
    }
  });
});

describe('hora de la pantalla «PAGADO»', () => {
  it('en hora de Madrid, aunque el aparato esté en UTC (verano +2, invierno +1)', () => {
    expect(clockTime(Date.parse('2026-07-15T21:41:07Z'))).toBe('23:41:07');
    expect(clockTime(Date.parse('2026-01-15T22:41:07Z'))).toBe('23:41:07');
    // Medianoche: «00», nunca «24».
    expect(clockTime(Date.parse('2026-01-15T23:05:09Z'))).toBe('00:05:09');
  });
});
