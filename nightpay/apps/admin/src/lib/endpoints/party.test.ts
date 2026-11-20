import { describe, expect, it } from 'vitest';
import { partyLiveQuery, partyRangeQuery } from './party';

/** Lo que el panel de OxioParty pide al API en la URL. */

describe('las consultas de OxioParty', () => {
  it('en directo: la noche (o una concreta) o la fiesta entera, y los minutos del aviso', () => {
    expect(partyLiveQuery({ scope: 'night' })).toBe('?scope=night');
    expect(partyLiveQuery({ scope: 'night', night: '2027-06-23', idleMin: 30 })).toBe('?scope=night&night=2027-06-23&idleMin=30');
    // La noche no va con la fiesta entera.
    expect(partyLiveQuery({ scope: 'event', night: '2027-06-23', idleMin: 15 })).toBe('?scope=event&idleMin=15');
  });

  it('el cierre: unas noches o, sin ellas, la fiesta entera', () => {
    expect(partyRangeQuery({})).toBe('');
    expect(partyRangeQuery({ from: '2027-06-23' })).toBe('');
    expect(partyRangeQuery({ from: '2027-06-23', to: '2027-06-24' })).toBe('?from=2027-06-23&to=2027-06-24');
  });
});
