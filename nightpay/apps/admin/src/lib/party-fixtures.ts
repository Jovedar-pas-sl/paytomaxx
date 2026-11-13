// Datos de ejemplo de OxioParty para las pruebas del panel (no se usan en la
// app): una noche de San Juan a la 01:47 de Madrid, con lo que daría el API.

import type { PartyLive, PartySettlement, StallStaffPerson, StallView } from '@nightpay/contracts';

export const PARTY_NOW = new Date('2027-06-23T23:47:00Z');

export function sampleLive(extra: Partial<PartyLive> = {}): PartyLive {
  return {
    scope: 'night',
    night: '2027-06-23',
    from: '2027-06-23T06:00:00.000Z',
    to: PARTY_NOW.toISOString(),
    generatedAt: PARTY_NOW.toISOString(),
    live: true,
    loaded: { totalCents: 1_845_000, cashCents: 855_000, cardCents: 730_000, phoneCents: 260_000, count: 652 },
    sold: { totalCents: 1_412_000, count: 3_468, refundedCents: 500 },
    lastHour: { loadedCents: 124_000, soldCents: 164_000 },
    inWristbandsCents: 433_000,
    activeWristbands: 1212,
    hourly: [
      { at: '2027-06-23T18:00:00.000Z', soldCents: 62_000, open: false },
      { at: '2027-06-23T19:00:00.000Z', soldCents: 0, open: false },
      { at: '2027-06-23T21:00:00.000Z', soldCents: 311_000, open: false },
      { at: '2027-06-23T23:00:00.000Z', soldCents: 164_000, open: true },
    ],
    stalls: [
      {
        id: 'canta',
        name: 'Peña El Cántaro',
        managerName: 'Ana R.',
        managerContact: '600 000 000',
        organizerBps: 1000,
        ownBar: false,
        active: true,
        soldCents: 384_000,
        count: 1102,
        lastAt: '2027-06-23T23:45:00.000Z',
        idle: false,
      },
      {
        id: 'barrio',
        name: 'Caseta Los del Barrio',
        managerName: 'Asociación de vecinos',
        managerContact: '611 111 111',
        organizerBps: 1000,
        ownBar: false,
        active: true,
        soldCents: 246_000,
        count: 701,
        lastAt: '2027-06-23T23:20:00.000Z',
        idle: true,
      },
      {
        id: 'comision',
        name: 'Barra de la Comisión',
        managerName: 'La comisión',
        managerContact: null,
        organizerBps: 10_000,
        ownBar: true,
        active: true,
        soldCents: 158_000,
        count: 512,
        lastAt: '2027-06-23T23:40:00.000Z',
        idle: false,
      },
      {
        id: 'churros',
        name: 'Churrería San Juan',
        managerName: 'Paqui',
        managerContact: 'paqui@churros.es',
        organizerBps: 800,
        ownBar: false,
        active: true,
        soldCents: 0,
        count: 0,
        lastAt: null,
        idle: false,
      },
      {
        id: null,
        name: 'Sin caseta',
        managerName: null,
        managerContact: null,
        organizerBps: null,
        ownBar: false,
        active: true,
        soldCents: 2_000,
        count: 1,
        lastAt: '2027-06-23T22:05:00.000Z',
        idle: false,
      },
    ],
    desks: [
      { key: 'person:u-1', kind: 'person', name: 'Lucía', cashCents: 624_000, cardCents: 418_000, cashInDeskCents: 620_000, count: 420 },
      { key: 'terminal:t-1', kind: 'terminal', name: 'Taquilla norte', cashCents: 231_000, cardCents: 312_000, cashInDeskCents: 231_000, count: 180 },
      { key: 'phone', kind: 'phone', name: 'Desde el móvil', cashCents: 0, cardCents: 260_000, cashInDeskCents: 0, count: 52 },
    ],
    alerts: [
      { kind: 'CASH_OVER', deskKey: 'person:u-1', name: 'Lucía', cashCents: 620_000, thresholdCents: 200_000 },
      { kind: 'STALL_IDLE', stallId: 'barrio', name: 'Caseta Los del Barrio', minutes: 27, managerName: 'Asociación de vecinos', managerContact: '611 111 111' },
    ],
    idleMinutes: 15,
    cashAlertCents: 200_000,
    event: {
      name: 'Fiestas de San Juan 2027',
      startsAt: '2027-06-23T18:00:00.000Z',
      endsAt: '2027-06-25T04:00:00.000Z',
      ended: false,
      nights: [
        { day: '2027-06-23', current: true },
        { day: '2027-06-24', current: false },
      ],
    },
    ...extra,
  };
}

export function sampleSettlement(extra: Partial<PartySettlement> = {}): PartySettlement {
  return {
    from: null,
    to: '2027-06-25T06:30:00.000Z',
    fromNight: null,
    toNight: null,
    generatedAt: '2027-06-25T06:30:00.000Z',
    eventName: 'Fiestas de San Juan 2027',
    rows: [
      {
        stallId: 'canta',
        name: 'Peña El Cántaro',
        managerName: 'Ana R.',
        soldCents: 792_000,
        count: 1102,
        organizerBps: 1000,
        ownBar: false,
        organizerCents: 79_200,
        toPayCents: 712_800,
        hasIban: true,
        ibanMasked: 'ES91 •••• •••• 1332',
        status: 'READY',
      },
      {
        stallId: 'comision',
        name: 'Barra de la Comisión',
        managerName: 'La comisión',
        soldCents: 326_000,
        count: 512,
        organizerBps: 10_000,
        ownBar: true,
        organizerCents: 326_000,
        toPayCents: 0,
        hasIban: false,
        ibanMasked: null,
        status: 'OWN_BAR',
      },
      {
        stallId: 'churros',
        name: 'Churrería San Juan',
        managerName: 'Paqui',
        soldCents: 184_000,
        count: 233,
        organizerBps: 800,
        ownBar: false,
        organizerCents: 14_720,
        toPayCents: 169_280,
        hasIban: false,
        ibanMasked: null,
        status: 'NO_IBAN',
      },
    ],
    totals: { soldCents: 1_302_000, organizerCents: 419_920, toPayCents: 882_080, transfers: 1, transfersCents: 712_800, missingIban: 1 },
    debtor: { name: 'Comisión de Fiestas', ibanMasked: 'ES79 •••• •••• 6789' },
    wristbands: { loadedCents: 1_500_000, refundedCents: 120_000, leftCents: 78_000 },
    ...extra,
  };
}

export const IBAN = 'ES9121000418450200051332';

export function sampleStall(extra: Partial<StallView> = {}): StallView {
  return {
    id: 's-1',
    name: 'Peña El Cántaro',
    managerName: 'Ana R.',
    managerContact: '600 000 000',
    organizerBps: 1000,
    ownBar: false,
    iban: IBAN,
    active: true,
    sortOrder: 0,
    staffCount: 2,
    createdAt: '2027-06-01T10:00:00.000Z',
    updatedAt: '2027-06-01T10:00:00.000Z',
    ...extra,
  };
}

export function samplePerson(extra: Partial<StallStaffPerson> = {}): StallStaffPerson {
  return { id: 'u-1', email: 'toni@fiesta.es', displayName: 'Toni', role: 'WAITER', stallId: 's-1', ...extra };
}
