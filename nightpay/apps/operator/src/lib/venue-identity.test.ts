import { describe, expect, it } from 'vitest';
import { NO_IDENTITY, placeInitials, placeName, venueIdentityOf } from './venue-identity';

describe('OxioParty: la caseta y el local de quien cobra (GET /v1/venues/me)', () => {
  it('lee la caseta (stall) y el nombre del local', () => {
    expect(venueIdentityOf({ name: 'Fallas Ruzafa', stall: { id: 's1', name: 'Peña El Cántaro' } })).toEqual({
      venueName: 'Fallas Ruzafa',
      stallName: 'Peña El Cántaro',
    });
  });

  it('sin caseta: solo el local; sin nada, nada', () => {
    expect(venueIdentityOf({ name: 'Fallas Ruzafa' })).toEqual({ venueName: 'Fallas Ruzafa', stallName: null });
    expect(venueIdentityOf({ name: 'Fallas Ruzafa', stall: null })).toEqual({ venueName: 'Fallas Ruzafa', stallName: null });
    expect(venueIdentityOf({ name: '  ', stall: { id: 's1', name: ' ' } })).toEqual(NO_IDENTITY);
    expect(venueIdentityOf({ name: null, stall: null })).toEqual(NO_IDENTITY);
    expect(venueIdentityOf(null)).toEqual(NO_IDENTITY);
  });

  it('la cabecera: la caseta; si no hay, el nombre del local', () => {
    expect(placeName({ venueName: 'Fallas Ruzafa', stallName: 'Peña El Cántaro' }, 'Barra')).toBe('Peña El Cántaro');
    expect(placeName({ venueName: 'Fallas Ruzafa', stallName: null }, 'Barra')).toBe('Fallas Ruzafa');
    expect(placeName(NO_IDENTITY, 'Barra')).toBe('Barra');
  });

  it('sus iniciales para el cuadro de la cabecera', () => {
    expect(placeInitials('Peña El Cántaro')).toBe('PC');
    expect(placeInitials('Taquilla')).toBe('T');
    expect(placeInitials('ébano  bar')).toBe('ÉB');
    expect(placeInitials('—')).toBe('·');
  });
});
