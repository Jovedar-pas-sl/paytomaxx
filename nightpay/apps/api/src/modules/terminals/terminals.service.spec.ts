import { describe, it, expect } from 'vitest';
import { canonicalizeZone, zoneToDisplay } from './terminals.service';

describe('canonicalizeZone', () => {
  it('devuelve null si zone es null/undefined', () => {
    expect(canonicalizeZone(null)).toBeNull();
    expect(canonicalizeZone(undefined)).toBeNull();
    expect(canonicalizeZone('')).toBeNull();
  });

  it('zone estándar pasa tal cual (BARRA/HABITACIONES/MESAS)', () => {
    expect(canonicalizeZone('BARRA')).toBe('BARRA');
    expect(canonicalizeZone('HABITACIONES')).toBe('HABITACIONES');
    expect(canonicalizeZone('MESAS')).toBe('MESAS');
  });

  it('OTRO sin zoneCustom devuelve null (no se crea zona OTRO sin nombre)', () => {
    expect(canonicalizeZone('OTRO')).toBeNull();
    expect(canonicalizeZone('OTRO', null)).toBeNull();
    expect(canonicalizeZone('OTRO', '')).toBeNull();
  });

  it('OTRO + zoneCustom genera OTRO/<UPPER> trimmed', () => {
    expect(canonicalizeZone('OTRO', 'vip room')).toBe('OTRO/VIP ROOM');
    expect(canonicalizeZone('OTRO', '  patio   ')).toBe('OTRO/PATIO');
    expect(canonicalizeZone('OTRO', 'Café exterior')).toBe('OTRO/CAFÉ EXTERIOR');
  });
});

describe('zoneToDisplay', () => {
  it('null → null', () => {
    expect(zoneToDisplay(null)).toBeNull();
  });

  it('zone estándar: capitalize first letter, resto minúsculas', () => {
    expect(zoneToDisplay('BARRA')).toBe('Barra');
    expect(zoneToDisplay('HABITACIONES')).toBe('Habitaciones');
    expect(zoneToDisplay('MESAS')).toBe('Mesas');
  });

  it('OTRO/<custom>: capitaliza el custom', () => {
    expect(zoneToDisplay('OTRO/VIP ROOM')).toBe('Vip room');
    expect(zoneToDisplay('OTRO/PATIO')).toBe('Patio');
  });

  it('round-trip: canonicalizeZone → zoneToDisplay preserva la idea', () => {
    const c = canonicalizeZone('OTRO', 'vip room');
    expect(c).toBe('OTRO/VIP ROOM');
    expect(zoneToDisplay(c)).toBe('Vip room');
  });
});
