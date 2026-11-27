import { describe, expect, it } from 'vitest';
import type { ApprovalView } from '@nightpay/contracts';
import type { Incident } from './api';
import { formatEur } from './money';
import { attentionList, hourlyLabel, hoursLine, moreAvisosLabel } from './resumen';
import { visibleTabs } from './roles';

// La portada «Resumen» (idea 13): «Pide tu atención» (hasta 3 filas, lo que
// decide el dueño delante) y la línea de las horas bajo «Pagado esta noche».

const NOW = new Date('2026-11-15T01:30:00Z');
const TZ = 'Europe/Madrid';
const ownerTabs = visibleTabs({ role: 'OWNER' });
const managerTabs = visibleTabs({ role: 'MANAGER' });

const approval = (id: string, requestedAt: string, o: Partial<ApprovalView> = {}): ApprovalView =>
  ({
    id,
    status: 'PENDING',
    amountCents: 14_000,
    requestedAt,
    expiresAt: '2026-11-16T00:00:00.000Z',
    requestedBy: { id: 'u-ana', name: 'Ana', role: 'MANAGER' },
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    failureReason: null,
    resultRef: null,
    canDecide: true,
    kind: 'REFUND',
    refund: {
      paymentId: 'p1',
      paymentAmountCents: 20_000,
      paymentCreatedAt: '2026-11-15T00:00:00.000Z',
      cardLast4: '4242',
      cardBrand: 'VISA',
      provider: 'PAYTEF',
      reason: null,
    },
    ...o,
  }) as ApprovalView;

const incident = (kind: Incident['kind'], occurredAt: string, o: Partial<Incident> = {}): Incident => ({
  kind,
  refId: `${kind}-${occurredAt}`,
  title: '',
  detail: '',
  occurredAt,
  amountCents: null,
  paymentId: null,
  ackable: false,
  ...o,
});

describe('«Pide tu atención»', () => {
  it('hasta 3 filas; lo que decide el dueño, delante (la más antigua primero), luego los avisos, lo nuevo arriba', () => {
    const { items, total } = attentionList({
      approvals: [approval('a2', '2026-11-15T01:00:00.000Z'), approval('a1', '2026-11-15T00:30:00.000Z'), approval('a3', '2026-11-15T00:00:00.000Z', { status: 'APPROVED' })],
      incidents: [incident('stuck_payment', '2026-11-15T00:10:00.000Z'), incident('bank_mismatch', '2026-11-15T01:20:00.000Z')],
      isOwner: true,
      tabs: ownerTabs,
      now: NOW,
      timeZone: TZ,
    });
    expect(total).toBe(4);
    expect(items.map((i) => i.key)).toEqual(['approval:a1', 'approval:a2', 'incident:bank_mismatch:bank_mismatch-2026-11-15T01:20:00.000Z']);
    expect(items[0]).toMatchObject({ tone: 'info', tag: 'Por aprobar', title: `Devolución · ${formatEur(14_000)}`, meta: 'hace 1 h', action: { kind: 'avisos', label: 'Decidir' } });
    expect(items[2]).toMatchObject({ tone: 'warning', tag: 'Banco', title: 'Diferencia con el banco', meta: 'hace 10 min', action: { kind: 'tab', tab: 'bank', label: 'Ir a Banco' } });
    expect(moreAvisosLabel(total)).toBe('Ver los 4 avisos');
    expect(moreAvisosLabel(3)).toBeNull();
  });

  it('solo lo que puede decidir quien mira; al dueño no le sale dos veces la incidencia de una solicitud', () => {
    const { items } = attentionList({
      approvals: [approval('a1', '2026-11-15T00:30:00.000Z', { canDecide: false })],
      incidents: [incident('approval_pending', '2026-11-15T00:30:00.000Z')],
      isOwner: true,
      tabs: ownerTabs,
      now: NOW,
      timeZone: TZ,
    });
    expect(items).toEqual([]);
  });

  it('el botón según el tipo: «Abrir cobro», «Ir a {pestaña}» o «Ver aviso»; el importe delante de cuándo', () => {
    const { items } = attentionList({
      approvals: null,
      incidents: [
        incident('refund_pending', '2026-11-15T01:29:30.000Z', { paymentId: 'p-9', amountCents: 2_500, title: 'Devolución de 25 € sin confirmar' }),
        incident('pos_unproven_sales', '2026-11-15T01:00:00.000Z'),
        incident('backup_stale', '2026-11-15T00:00:00.000Z'),
      ],
      isOwner: false,
      tabs: managerTabs,
      now: NOW,
      timeZone: TZ,
    });
    expect(items.map((i) => i.action)).toEqual([
      { kind: 'payment', label: 'Abrir cobro', paymentId: 'p-9' },
      // Banco es del dueño: el encargado no lo ve.
      { kind: 'avisos', label: 'Ver aviso' },
      { kind: 'avisos', label: 'Ver aviso' },
    ]);
    expect(items[0]).toMatchObject({ tag: 'Devolución', title: 'Devolución de 25 € sin confirmar', meta: `${formatEur(2_500)} · ahora` });
  });

  it('el «No es mío» de una compañera (service_disputed, PR #68): «Personal», su título e «Ir a Cobros», aunque traiga el cobro', () => {
    const { items } = attentionList({
      approvals: null,
      incidents: [incident('service_disputed', '2026-11-15T01:00:00.000Z', { paymentId: 'p-7', amountCents: 6_000, title: 'Nerea dice que el servicio C-0031 no es suyo' })],
      isOwner: false,
      tabs: managerTabs,
      now: NOW,
      timeZone: TZ,
    });
    expect(items[0]).toMatchObject({
      tone: 'warning',
      tag: 'Personal',
      title: 'Nerea dice que el servicio C-0031 no es suyo',
      action: { kind: 'tab', tab: 'payments', label: 'Ir a Cobros' },
    });
  });

  it('nada pendiente: lista vacía; sin datos aún, también', () => {
    expect(attentionList({ approvals: [], incidents: [], isOwner: true, tabs: ownerTabs, now: NOW, timeZone: TZ })).toEqual({ items: [], total: 0 });
    expect(attentionList({ approvals: null, incidents: null, isOwner: true, tabs: ownerTabs, now: NOW, timeZone: TZ })).toEqual({ items: [], total: 0 });
  });
});

describe('la línea de las horas', () => {
  // De las 22 h a la 1 h de Madrid (21:00 a 00:00 UTC): el pico, a las 23 h.
  const hourly = [
    { at: '2026-11-14T21:00:00.000Z', chargedCents: 4_000, open: false },
    { at: '2026-11-14T22:00:00.000Z', chargedCents: 9_000, open: false },
    { at: '2026-11-14T23:00:00.000Z', chargedCents: 2_000, open: false },
    { at: '2026-11-15T00:00:00.000Z', chargedCents: 1_000, open: true },
  ];

  it('«{N} pagos · el pico, a las {h} h · de media {importe}»: N son los pagos y las recargas en efectivo', () => {
    const line = hoursLine({ count: 7, cashTopUpsCount: 1, chargedCents: 16_000, hourly, timeZone: TZ })!;
    expect(`${line.lead} ${formatEur(line.averageCents)}`).toBe(`8 pagos · el pico, a las 23 h · de media ${formatEur(2_000)}`);
  });

  it('en la franja entera (encargado sin informes), desde «el pico»; un solo pago, en singular; sin horas, sin pico', () => {
    expect(hoursLine({ count: 7, cashTopUpsCount: 1, chargedCents: 16_000, hourly, timeZone: TZ, full: true })!.lead).toBe('el pico, a las 23 h · de media');
    expect(hoursLine({ count: 1, chargedCents: 1_000, hourly: undefined, timeZone: TZ })!.lead).toBe('1 pago · de media');
    expect(hoursLine({ count: 0, chargedCents: 0, hourly: [], timeZone: TZ })).toBeNull();
  });

  it('lo que lee el lector de pantalla del gráfico: de la primera hora a la de ahora, en la hora del local', () => {
    expect(hourlyLabel(hourly, TZ)).toBe('Por hora, de 22 h a 1 h');
  });
});
