import { describe, expect, it } from 'vitest';
import { QR_RETRY_AFTER_LIMIT_MS, QR_RETRY_AFTER_MS, rejectedQr, shouldResolveQr, statusOf } from './qr-scan';

const QR = 'https://operator.local/?invita=aaaaaaaaaaaaaaaaaaaaaaaa.bbbb';
const OTHER = 'https://operator.local/?invita=cccccccccccccccccccccccc.dddd';
const NOW = 1_000_000;

describe('«Escanea el QR de la chica»: cuándo se pregunta al API', () => {
  it('un QR nuevo, siempre', () => {
    expect(shouldResolveQr(QR, null, NOW)).toBe(true);
  });

  it('rechazado (caducado, de otro local, no es de una chica): no se vuelve a mandar mientras siga delante de la cámara', () => {
    for (const status of [400, 403, 404, 410]) {
      const rejected = rejectedQr(QR, status, NOW);
      // La cámara lo lee 4 veces por segundo: ni en un minuto ni en una hora.
      expect(shouldResolveQr(QR, rejected, NOW + 250)).toBe(false);
      expect(shouldResolveQr(QR, rejected, NOW + 60 * 60_000)).toBe(false);
      // Otro QR (la chica lo vuelve a abrir, u otra chica): sí.
      expect(shouldResolveQr(OTHER, rejected, NOW + 250)).toBe(true);
    }
  });

  it('sin red o con el servidor caído: el mismo QR, pasado un rato', () => {
    for (const status of [0, 408, 500, 502, 503]) {
      const rejected = rejectedQr(QR, status, NOW);
      expect(shouldResolveQr(QR, rejected, NOW + QR_RETRY_AFTER_MS - 1)).toBe(false);
      expect(shouldResolveQr(QR, rejected, NOW + QR_RETRY_AFTER_MS)).toBe(true);
    }
  });

  it('«demasiadas peticiones» (el límite por IP de todo el local): se espera más', () => {
    const rejected = rejectedQr(QR, 429, NOW);
    expect(shouldResolveQr(QR, rejected, NOW + QR_RETRY_AFTER_MS)).toBe(false);
    expect(shouldResolveQr(QR, rejected, NOW + QR_RETRY_AFTER_LIMIT_MS)).toBe(true);
  });

  it('en un minuto delante de un QR rechazado, una sola pregunta (antes, una tras cada respuesta: 2-4 por segundo)', () => {
    let rejected = null as ReturnType<typeof rejectedQr> | null;
    let asked = 0;
    for (let t = NOW; t < NOW + 60_000; t += 250) {
      if (!shouldResolveQr(QR, rejected, t)) continue;
      asked += 1;
      rejected = rejectedQr(QR, 400, t);
    }
    expect(asked).toBe(1);
  });

  it('el código HTTP de un error (0 si no hubo respuesta)', () => {
    expect(statusOf(Object.assign(new Error('caducado'), { status: 400 }))).toBe(400);
    expect(statusOf(new TypeError('Failed to fetch'))).toBe(0);
    expect(statusOf(null)).toBe(0);
    expect(statusOf({ status: '500' })).toBe(0);
  });
});
