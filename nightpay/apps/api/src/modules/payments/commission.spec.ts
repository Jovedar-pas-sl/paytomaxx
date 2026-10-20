import { describe, it, expect } from 'vitest';
import {
  resolveBpsForOperator,
  DEFAULT_COMMISSION_DEFAULTS,
} from './commission';

describe('resolveBpsForOperator', () => {
  const venueMap = {
    CHICA_SERVICE: 8500, // 85%
    VENUE_BAR: 500, // 5% — propina opcional al camarero
    VENUE_ROOM: 0,
    VENUE_FOOD: 0,
    EXTRA: 200, // 2%
  };

  describe('CHICA_SERVICE', () => {
    it('usa User.commissionBps si está presente (override de venue default)', () => {
      const r = resolveBpsForOperator({
        category: 'CHICA_SERVICE',
        userCommissionBpsOverride: 9500, // chica al 95% (premium)
        venueMap,
      });
      expect(r).toBe(9500);
    });

    it('cae a venue default si User.commissionBps es null', () => {
      const r = resolveBpsForOperator({
        category: 'CHICA_SERVICE',
        userCommissionBpsOverride: null,
        venueMap,
      });
      expect(r).toBe(8500);
    });

    it('venue null → usa DEFAULT_COMMISSION_DEFAULTS.CHICA_SERVICE (9000)', () => {
      const r = resolveBpsForOperator({
        category: 'CHICA_SERVICE',
        userCommissionBpsOverride: null,
        venueMap: null,
      });
      expect(r).toBe(DEFAULT_COMMISSION_DEFAULTS.CHICA_SERVICE);
    });
  });

  describe('VENUE_* (ingreso local)', () => {
    it('VENUE_BAR ignora User.commissionBps override (es ingreso local, no chica)', () => {
      const r = resolveBpsForOperator({
        category: 'VENUE_BAR',
        userCommissionBpsOverride: 9500, // intentar usar override de chica
        venueMap,
      });
      expect(r).toBe(500); // ignora override, usa venue default
    });

    it('VENUE_ROOM con default 0 → camarero no gana nada (es ingreso 100% local)', () => {
      const r = resolveBpsForOperator({
        category: 'VENUE_ROOM',
        userCommissionBpsOverride: 9000,
        venueMap,
      });
      expect(r).toBe(0);
    });

    it('VENUE_FOOD → venue default', () => {
      const r = resolveBpsForOperator({
        category: 'VENUE_FOOD',
        userCommissionBpsOverride: 9000,
        venueMap,
      });
      expect(r).toBe(0);
    });
  });

  describe('EXTRA', () => {
    it('EXTRA ignora User.commissionBps → venue default', () => {
      const r = resolveBpsForOperator({
        category: 'EXTRA',
        userCommissionBpsOverride: 9000,
        venueMap,
      });
      expect(r).toBe(200);
    });
  });

  describe('Partial venueMap', () => {
    it('merge con DEFAULT_COMMISSION_DEFAULTS — claves omitidas usan default', () => {
      const r = resolveBpsForOperator({
        category: 'VENUE_FOOD',
        userCommissionBpsOverride: null,
        venueMap: { VENUE_BAR: 700 }, // solo VENUE_BAR override, VENUE_FOOD ausente
      });
      // VENUE_FOOD del DEFAULT_COMMISSION_DEFAULTS = 0
      expect(r).toBe(0);
    });
  });

  describe('Categoría desconocida (defensa)', () => {
    it('categoría fuera del enum → 0 (no rompe)', () => {
      const r = resolveBpsForOperator({
        category: 'LEGACY_UNKNOWN_FOO',
        userCommissionBpsOverride: 9000,
        venueMap,
      });
      expect(r).toBe(0);
    });
  });

  describe('Caso real: chica al 90% en su servicio + camarero al 0% en bar', () => {
    const lunaVlc = {
      CHICA_SERVICE: 9000,
      VENUE_BAR: 0,
      VENUE_ROOM: 0,
      VENUE_FOOD: 0,
      EXTRA: 0,
    };

    it('chica Ana con commissionBps=9000 cobra "Mi servicio" 100€ → 90€', () => {
      const bps = resolveBpsForOperator({
        category: 'CHICA_SERVICE',
        userCommissionBpsOverride: 9000,
        venueMap: lunaVlc,
      });
      const commission = Math.round((10000 * bps) / 10_000);
      expect(commission).toBe(9000); // 90€ en cents
    });

    it('chica Ana cobra "Bar" 100€ → 0€ de comisión (es ingreso del local)', () => {
      const bps = resolveBpsForOperator({
        category: 'VENUE_BAR',
        userCommissionBpsOverride: 9000, // su override no aplica a VENUE_*
        venueMap: lunaVlc,
      });
      const commission = Math.round((10000 * bps) / 10_000);
      expect(commission).toBe(0);
    });

    it('chica premium al 95% override de venue 90% en CHICA_SERVICE', () => {
      const bps = resolveBpsForOperator({
        category: 'CHICA_SERVICE',
        userCommissionBpsOverride: 9500,
        venueMap: lunaVlc,
      });
      const commission = Math.round((20000 * bps) / 10_000); // 200€ cobro
      expect(commission).toBe(19000); // 190€
    });
  });
});
