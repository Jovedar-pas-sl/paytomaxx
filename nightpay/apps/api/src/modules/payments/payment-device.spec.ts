import { describe, expect, it, vi } from 'vitest';
import { deviceWhoOf, insertPaymentEvent, paymentDevicePayload, recordPaymentDevice, withoutIp } from './payment-device';
import { mayReadCobro, seesWholeVenue } from './payment-read-access';

const LOLA = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d01';
const SALA = 'a1a1a1a1-0000-4000-8000-000000000001';
const IPHONE = { model: 'iPhone', os: 'iOS', osVersion: '18', browser: 'Safari 18', mobile: true, inApp: null, ip: '83.45.120.7' };

describe('el dispositivo de cada paso del cobro', () => {
  it('de quién es: con sesión, del personal; con local y sin persona, del datáfono; sin nada, del cliente', () => {
    expect(deviceWhoOf({ userId: LOLA, tenantId: SALA })).toBe('staff');
    expect(deviceWhoOf({ tenantId: SALA })).toBe('device');
    expect(deviceWhoOf({})).toBe('client');
    expect(deviceWhoOf(undefined)).toBe('client');
  });

  it('el evento lleva quién, el paso, el móvil y la IP; sin dispositivo (trabajos del sistema), nada', () => {
    expect(paymentDevicePayload({ userId: LOLA, tenantId: SALA, device: IPHONE }, 'create', { walletChargeId: 'w-1', authMethod: undefined })).toEqual({
      who: 'staff',
      step: 'create',
      userId: LOLA,
      walletChargeId: 'w-1',
      ...IPHONE,
    });
    expect(paymentDevicePayload({ traceId: 't' }, 'create')).toBeNull();
  });

  it('para guardar el saldo antes y después aunque no se sepa el móvil', () => {
    expect(paymentDevicePayload(undefined, 'saldo', { balanceBeforeCents: 100, balanceAfterCents: 0 }, { evenWithoutDevice: true })).toMatchObject({
      who: 'client',
      model: null,
      ip: null,
      balanceBeforeCents: 100,
      balanceAfterCents: 0,
    });
  });

  it('para el registro (no se puede borrar): sin la IP', () => {
    const p = paymentDevicePayload({ device: IPHONE }, 'saldo')!;
    expect(withoutIp(p)).not.toHaveProperty('ip');
  });

  it('se escribe en SQL crudo (vale en cualquier transacción) y solo si hay dispositivo', async () => {
    const tx = { $executeRaw: vi.fn(async (..._args: unknown[]) => 1) };
    expect(await recordPaymentDevice(tx as never, { device: IPHONE, traceId: 'trace-1' }, { id: 'p-1', tenantId: SALA }, 'card', { who: 'client' })).toBe(true);
    expect(await recordPaymentDevice(tx as never, {}, { id: 'p-1', tenantId: SALA }, 'card')).toBe(false);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = tx.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toContain('INSERT INTO payment_events');
    expect(values.slice(0, 3)).toEqual(['p-1', SALA, 'payment.device']);
    expect(JSON.parse(values[3] as string)).toMatchObject({ who: 'client', step: 'card', ip: '83.45.120.7' });
    await insertPaymentEvent(tx as never, { paymentId: 'p-2', tenantId: SALA, eventType: 'payment.wallet_credited', payload: {} });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });
});

describe('quién puede leer un cobro', () => {
  it('el dueño y el encargado, todos; el resto, solo los suyos', () => {
    expect(seesWholeVenue('OWNER')).toBe(true);
    expect(seesWholeVenue('WAITER')).toBe(false);
    expect(mayReadCobro({ userId: 'x', role: 'MANAGER' }, LOLA)).toBe(true);
    expect(mayReadCobro({ userId: LOLA, role: 'OPERATOR' }, LOLA)).toBe(true);
    expect(mayReadCobro({ userId: 'camarero', role: 'WAITER' }, LOLA)).toBe(false);
    expect(mayReadCobro({ userId: 'camarero', role: 'WAITER' }, null)).toBe(false);
  });
});
