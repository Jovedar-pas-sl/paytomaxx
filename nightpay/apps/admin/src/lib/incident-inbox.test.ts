import { describe, expect, it } from 'vitest';
import type { Incident } from './api';
import {
  INCIDENT_KINDS,
  fixTabFor,
  incidentHeading,
  incidentKey,
  recordResolved,
  resolvedToday,
  vanished,
  type ResolvedIncident,
} from './incident-inbox';
import { visibleTabs } from './roles';

function incident(over: Partial<Incident> = {}): Incident {
  return {
    kind: 'duplicate_charge',
    refId: 'r1',
    title: 'El cliente pagó dos veces',
    detail: 'Devuelve uno en BBVA.',
    occurredAt: '2026-10-15T01:00:00.000Z',
    amountCents: 4500,
    paymentId: 'p1',
    ackable: true,
    ...over,
  };
}

function resolved(over: Partial<ResolvedIncident> = {}): ResolvedIncident {
  return {
    key: 'duplicate_charge:r1',
    kind: 'duplicate_charge',
    title: 'El cliente pagó dos veces',
    resolvedAt: '2026-10-15T02:00:00.000Z',
    how: 'ack',
    ...over,
  };
}

describe('INCIDENT_KINDS', () => {
  it('cada tipo tiene grupo y título en castellano', () => {
    for (const meta of Object.values(INCIDENT_KINDS)) {
      expect(meta.group.length).toBeGreaterThan(2);
      expect(meta.title.length).toBeGreaterThan(5);
    }
    expect(INCIDENT_KINDS.stuck_payment.group).toBe('Cobro');
    expect(INCIDENT_KINDS.bank_mismatch.group).toBe('Banco');
  });
});

describe('incidentHeading', () => {
  it('el título del API manda; vacío, el del tipo', () => {
    expect(incidentHeading(incident())).toBe('El cliente pagó dos veces');
    expect(incidentHeading(incident({ title: '  ' }))).toBe(INCIDENT_KINDS.duplicate_charge.title);
  });
});

describe('approval_pending (solicitud del encargado sin decidir)', () => {
  it('se arregla en «Por aprobar», que solo ve el dueño', () => {
    expect(INCIDENT_KINDS.approval_pending.group).toBe('Por aprobar');
    expect(fixTabFor('approval_pending', visibleTabs({ role: 'OWNER' }))).toBe('approvals');
    expect(fixTabFor('approval_pending', visibleTabs({ role: 'MANAGER' }))).toBeNull();
  });
});

describe('refund_pending (devolución sin confirmar por el banco)', () => {
  it('no se marca a mano: se abre el cobro (Devoluciones → Resolver) y se quita sola', () => {
    expect(INCIDENT_KINDS.refund_pending.group).toBe('Devolución');
    expect(INCIDENT_KINDS.refund_pending.opensPayment).toBe(true);
    expect(fixTabFor('refund_pending', visibleTabs({ role: 'MANAGER' }))).toBe('payments');
  });

  it('el resto de tipos no abren un cobro', () => {
    expect(INCIDENT_KINDS.duplicate_charge.opensPayment).toBeFalsy();
  });
});

describe('incidentKey', () => {
  it('tipo y referencia', () => {
    expect(incidentKey(incident())).toBe('duplicate_charge:r1');
  });
});

describe('fixTabFor', () => {
  it('lleva a la pestaña donde se arregla, si ese rol la ve', () => {
    expect(fixTabFor('stuck_payment', visibleTabs({ role: 'MANAGER' }))).toBe('payments');
    expect(fixTabFor('wallet_close_requested', visibleTabs({ role: 'MANAGER' }))).toBe('wallets');
    expect(fixTabFor('bank_mismatch', visibleTabs({ role: 'OWNER' }))).toBe('bank');
    expect(fixTabFor('bank_mismatch', visibleTabs({ role: 'MANAGER' }))).toBeNull();
    expect(fixTabFor('backup_stale', visibleTabs({ role: 'OWNER' }))).toBeNull();
  });
});

describe('vanished', () => {
  it('lo que estaba abierto y ya no viene', () => {
    const a = incident({ refId: 'a' });
    const b = incident({ refId: 'b' });
    const c = incident({ refId: 'c' });
    expect(vanished([a, b], [b, c]).map((i) => i.refId)).toEqual(['a']);
    expect(vanished([], [a])).toEqual([]);
  });
});

describe('resolvedToday / recordResolved', () => {
  it('solo cuenta lo del mismo día del local', () => {
    const log = { day: '2026-10-15', items: [resolved()] };
    expect(resolvedToday(log, '2026-10-15')).toHaveLength(1);
    expect(resolvedToday(log, '2026-10-16')).toEqual([]);
    expect(resolvedToday(null, '2026-10-15')).toEqual([]);
  });

  it('lo más reciente arriba, sin repetir y sin tocar el registro anterior', () => {
    const before = { day: '2026-10-15', items: [resolved({ key: 'x', resolvedAt: '2026-10-15T01:00:00.000Z' })] };
    const after = recordResolved(before, '2026-10-15', [
      resolved({ key: 'y', resolvedAt: '2026-10-15T03:00:00.000Z' }),
      resolved({ key: 'x', resolvedAt: '2026-10-15T04:00:00.000Z', note: 'devuelto' }),
    ]);
    expect(after.items.map((i) => i.key)).toEqual(['x', 'y']);
    expect(after.items[0]?.note).toBe('devuelto');
    expect(before.items).toHaveLength(1);
  });

  it('un día nuevo empieza vacío', () => {
    const old = { day: '2026-10-14', items: [resolved({ key: 'old' })] };
    expect(recordResolved(old, '2026-10-15', [resolved({ key: 'new' })]).items.map((i) => i.key)).toEqual(['new']);
  });

  it('guarda como mucho 50', () => {
    const many = Array.from({ length: 60 }, (_, n) =>
      resolved({ key: `k${n}`, resolvedAt: new Date(Date.UTC(2026, 9, 15, 0, n)).toISOString() }),
    );
    expect(recordResolved(null, '2026-10-15', many).items).toHaveLength(50);
  });
});
