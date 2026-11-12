import { describe, it, expect, afterEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { BtcpayEnabledGuard, btcpayEnabled } from './btcpay-flag';

describe('btcpayEnabled: apagado por defecto', () => {
  it.each([undefined, '', 'false', '0', 'no', 'off', 'nada', ' '])('%s = apagado', (v) => {
    expect(btcpayEnabled({ BTCPAY_ENABLED: v })).toBe(false);
  });
  it.each(['true', 'TRUE', '1', 'yes', 'on', ' true '])('%s = encendido', (v) => {
    expect(btcpayEnabled({ BTCPAY_ENABLED: v })).toBe(true);
  });
  it('sin la variable, apagado', () => {
    expect(btcpayEnabled({})).toBe(false);
  });
  it('acepta un booleano ya leído por la configuración', () => {
    expect(btcpayEnabled({ BTCPAY_ENABLED: true })).toBe(true);
    expect(btcpayEnabled({ BTCPAY_ENABLED: false })).toBe(false);
  });
});

describe('BtcpayEnabledGuard: con el interruptor apagado las rutas no existen', () => {
  const before = process.env.BTCPAY_ENABLED;
  afterEach(() => {
    if (before === undefined) delete process.env.BTCPAY_ENABLED;
    else process.env.BTCPAY_ENABLED = before;
  });

  it('404 sin la variable', () => {
    delete process.env.BTCPAY_ENABLED;
    expect(() => new BtcpayEnabledGuard().canActivate()).toThrow(NotFoundException);
  });
  it('deja pasar con la variable encendida', () => {
    process.env.BTCPAY_ENABLED = 'true';
    expect(new BtcpayEnabledGuard().canActivate()).toBe(true);
  });
});
