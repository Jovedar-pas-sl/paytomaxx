// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { ApprovalView, PermissionSet } from '@nightpay/contracts';
import { createPayoutBatch, fetchApprovalRules, fetchMyPermissions, fetchOperators, fetchStepUp, type Operator } from '@/lib/api';
import { ApiError } from '@/lib/api-errors';
import { ApprovalsContext } from '@/lib/use-approvals';
import { BATCH_2FA_TEXT } from '@/lib/payout-batch';
import { FichasContext } from './fichas/fichas-context';
import { PayoutBatchList } from './PayoutBatchList';

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchOperators: vi.fn(),
  fetchApprovalRules: vi.fn(),
  fetchMyPermissions: vi.fn(),
  fetchStepUp: vi.fn(),
  createPayoutBatch: vi.fn(),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function op(id: string, name: string, over: Partial<Operator> = {}): Operator {
  return {
    id,
    email: `${id}@x.es`,
    displayName: name,
    commissionBps: 5000,
    active: true,
    invitedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    balance: { pendingCents: 30_000, availableCents: 30_000, paidCents: 0, lifetimeGrossCents: 0, count: 3 },
    payoutMethod: 'SEPA_IBAN',
    payoutAddressMasked: 'ES12 •••• •••• 4821',
    ...over,
  };
}

// Con la llave nueva del #68 (chargeForOperator): un PermissionSet escrito a mano la necesita.
const PERMS: PermissionSet = {
  refund: false,
  cash: false,
  closeNight: false,
  payouts: true,
  reports: false,
  cashTopUp: false,
  cashPayout: false,
  chargeForOperator: false,
};

const GIRLS = [
  op('00000000-0000-4000-8000-000000000002', 'Marta'),
  op('00000000-0000-4000-8000-000000000003', 'Ana', { payoutHolderMismatch: true }),
  op('00000000-0000-4000-8000-000000000004', 'Zoe', { payoutMethod: 'MANUAL_CASH', payoutAddressMasked: null }),
  op('00000000-0000-4000-8000-000000000005', 'Nadie', { balance: { pendingCents: 0, availableCents: 0, paidCents: 0, lifetimeGrossCents: 0, count: 0 } }),
];
const WAITERS = [op('00000000-0000-4000-8000-000000000006', 'Luis')];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  vi.mocked(fetchOperators).mockReset();
  vi.mocked(fetchOperators).mockImplementation(async (role) => (role === 'WAITER' ? WAITERS : GIRLS));
  vi.mocked(fetchApprovalRules).mockResolvedValue({ payoutRequiresApproval: false, refundApprovalThresholdCents: 0, payout: 'direct', refundRequestFromCents: null });
  vi.mocked(fetchMyPermissions).mockResolvedValue(PERMS);
  vi.mocked(fetchStepUp).mockResolvedValue({ method: 'totp' } as Awaited<ReturnType<typeof fetchStepUp>>);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => undefined);
};
const text = () => host.textContent ?? '';
const boxes = () => Array.from(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
const buttons = (label: string) => Array.from(host.querySelectorAll('button')).filter((b) => b.textContent === label);

const bodyText = () => document.body.textContent ?? '';
const bodyButton = (label: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label);

/** Marca a Marta, abre el repaso, confirma y pone el código. */
async function payMarta() {
  act(() => boxes().find((b) => b.closest('label')?.textContent?.includes('Marta'))!.click());
  act(() => buttons('Repasar y pagar')[0]!.click());
  act(() => document.querySelector<HTMLInputElement>('.np-hoja input[type="checkbox"]')!.click());
  const input = document.querySelector<HTMLInputElement>('.np-otp-input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '123456');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

async function mount(isOwner: boolean, pending: ApprovalView[] | null = null, openOperator: (id: string, onChanged?: () => void) => void = () => undefined) {
  act(() =>
    root.render(
      <FichasContext.Provider value={{ openWallet: () => undefined, openOperator }}>
        <ApprovalsContext.Provider value={{ rules: null, pending, error: null, refresh: () => undefined }}>
          <PayoutBatchList isOwner={isOwner} onNavigate={() => undefined} />
        </ApprovalsContext.Provider>
      </FichasContext.Provider>,
    ),
  );
  await flush();
}

describe('«A quién hay que pagar»', () => {
  it('pide las dos listas a la vez, enseña solo lo que hay que pagar, por nombre, y el camarero lo dice', async () => {
    await mount(true);
    expect(fetchOperators).toHaveBeenCalledWith();
    expect(fetchOperators).toHaveBeenCalledWith('WAITER');
    const names = Array.from(host.querySelectorAll('.np-lote-name, .np-checkbox-label')).map((n) => n.textContent);
    expect(names).toEqual(['Todas', 'Ana', 'Luis · camarero', 'Marta', 'Zoe']);
    expect(text()).not.toContain('Nadie');
    expect(text()).toContain('Transferencia · ES12 •••• •••• 4821');
  });

  it('el dueño con 2FA marca: «Todas», casillas, barra y efectivo sin casilla con «Pagar»', async () => {
    await mount(true);
    // «Todas» + Ana, Luis y Marta (Zoe cobra en efectivo).
    expect(boxes()).toHaveLength(4);
    expect(text()).toContain('Cobra en efectivo: se paga una a una');
    expect(buttons('Pagar')).toHaveLength(1);
    expect(text()).toContain('Marca a quién pagas');
    const repasar = buttons('Repasar y pagar')[0]!;
    expect(repasar.disabled).toBe(true);
    act(() => boxes()[1]!.click());
    expect(text()).toContain('Pagar a 1: 300,00\u00a0€');
    expect(repasar.disabled).toBe(false);
    act(() => boxes()[0]!.click());
    expect(text()).toContain('Pagar a 3: 900,00\u00a0€');
  });

  it('el titular que no se parece se marca igual, con su aviso debajo', async () => {
    await mount(true);
    expect(text()).toContain('El titular no se parece al nombre de la compañera («Ana»)');
    expect(boxes()[1]!.disabled).toBe(false);
  });

  it('cada fila lleva «Ver ficha de …»', async () => {
    await mount(true);
    expect(host.querySelector('button[aria-label="Ver ficha de Marta"]')).not.toBeNull();
  });

  it('sin 2FA ni llave (method === null): sin casillas ni barra, «Pagar» por fila y la franja con «Ir a Seguridad»', async () => {
    vi.mocked(fetchStepUp).mockResolvedValue({ method: null } as Awaited<ReturnType<typeof fetchStepUp>>);
    await mount(true);
    expect(boxes()).toHaveLength(0);
    expect(text()).not.toContain('Repasar y pagar');
    expect(buttons('Pagar')).toHaveLength(4);
    expect(text()).toContain(BATCH_2FA_TEXT);
    expect(buttons('Ir a Seguridad')).toHaveLength(1);
  });

  it('el encargado en «pedir»: sin casillas ni barra, «Pedir al dueño» por fila y la franja', async () => {
    vi.mocked(fetchApprovalRules).mockResolvedValue({ payoutRequiresApproval: true, refundApprovalThresholdCents: 0, payout: 'request', refundRequestFromCents: null });
    await mount(false);
    expect(boxes()).toHaveLength(0);
    expect(text()).not.toContain('Repasar y pagar');
    expect(buttons('Pedir al dueño')).toHaveLength(4);
    expect(text()).toContain('En este local los pagos los aprueba el dueño');
  });

  it('el encargado con direct_2fa y permiso marca; sin permiso, solo mira', async () => {
    vi.mocked(fetchApprovalRules).mockResolvedValue({ payoutRequiresApproval: false, refundApprovalThresholdCents: 0, payout: 'direct_2fa', refundRequestFromCents: null });
    await mount(false);
    expect(boxes()).toHaveLength(4);
    act(() => root.unmount());
    root = createRoot(host);
    vi.mocked(fetchMyPermissions).mockResolvedValue({ ...PERMS, payouts: false });
    await mount(false);
    expect(boxes()).toHaveLength(0);
    expect(text()).toContain('No tienes permiso para pagar');
    expect(buttons('Pagar')).toHaveLength(0);
    expect(text()).not.toContain('Repasar y pagar');
  });

  it('con solicitud pendiente (el dueño): «Te lo ha pedido Luis: decídelo en Avisos» y «Decidir», sin casilla', async () => {
    const pending = [
      {
        id: '00000000-0000-4000-8000-0000000000aa',
        kind: 'PAYOUT',
        status: 'PENDING',
        amountCents: 30_000,
        requestedBy: { id: '00000000-0000-4000-8000-0000000000bb', name: 'Luis', role: 'MANAGER' },
        payout: { operatorId: GIRLS[0]!.id, operatorName: 'Marta' },
      },
    ] as unknown as ApprovalView[];
    await mount(true, pending);
    expect(text()).toContain('Te lo ha pedido Luis: decídelo en Avisos');
    expect(buttons('Decidir')).toHaveLength(1);
    expect(boxes()).toHaveLength(3);
  });

  it('cargando: silueta de 5 filas; vacío: «No hay nada que pagar ahora»', async () => {
    vi.mocked(fetchOperators).mockImplementation(() => new Promise(() => undefined));
    act(() => root.render(<PayoutBatchList isOwner onNavigate={() => undefined} />));
    expect(host.querySelectorAll('.np-lote-skel')).toHaveLength(5);
    act(() => root.unmount());
    root = createRoot(host);
    vi.mocked(fetchOperators).mockResolvedValue([]);
    await mount(true);
    expect(text()).toContain('No hay nada que pagar ahora');
  });

  it('falla una lista: la otra y su franja con «Reintentar»; fallan las dos: otra franja', async () => {
    vi.mocked(fetchOperators).mockImplementation(async (role) => {
      if (role === 'WAITER') throw new Error('x');
      return GIRLS;
    });
    await mount(true);
    expect(text()).toContain('No se pudieron cargar los camareros.');
    expect(text()).toContain('Marta');
    expect(buttons('Reintentar')).toHaveLength(1);
    act(() => root.unmount());
    root = createRoot(host);
    vi.mocked(fetchOperators).mockRejectedValue(new Error('x'));
    await mount(true);
    expect(text()).toContain('No se pudo cargar a quién hay que pagar.');
  });

  it('nunca recarga sola: solo al entrar y con «Volver a cargar»', async () => {
    await mount(true);
    expect(fetchOperators).toHaveBeenCalledTimes(2);
    act(() => buttons('Volver a cargar')[0]!.click());
    await flush();
    expect(fetchOperators).toHaveBeenCalledTimes(4);
  });

  it('un pago hecho desde «Ver ficha» recarga la lista y no deja abrir otro repaso hasta que acabe', async () => {
    let changed: (() => void) | undefined;
    await mount(true, null, (_id, onChanged) => {
      changed = onChanged;
    });
    act(() => boxes().find((b) => b.closest('label')?.textContent?.includes('Marta'))!.click());
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Ver ficha de Marta"]')!.click());
    expect(changed).toBeTypeOf('function');
    const waiting: (() => void)[] = [];
    vi.mocked(fetchOperators).mockImplementation(
      (role) => new Promise((resolve) => waiting.push(() => resolve(role === 'WAITER' ? WAITERS : GIRLS.filter((g) => g.displayName !== 'Marta')))),
    );
    act(() => changed!());
    expect(fetchOperators).toHaveBeenCalledTimes(4);
    expect(buttons('Repasar y pagar')[0]!.disabled).toBe(true);
    waiting.forEach((go) => go());
    await flush();
    expect(text()).not.toContain('Marta');
    expect(text()).toContain('Marca a quién pagas');
  });

  it('lote sin respuesta: el aviso queda en la lista y «Repasar y pagar» espera al minuto y a «Volver a cargar la lista»', async () => {
    vi.mocked(createPayoutBatch).mockRejectedValue(new ApiError('red', 0));
    await mount(true);
    await payMarta();
    act(() => bodyButton('Volver a cargar la lista')!.click());
    await flush();
    expect(bodyText()).toContain('No sabemos si se apuntaron todos: el servidor no contestó y puede que siga apuntándolos.');
    act(() => boxes()[1]!.click());
    expect(buttons('Repasar y pagar')[0]!.disabled).toBe(true);
    // Antes del minuto, volver a cargar no basta.
    act(() => buttons('Volver a cargar la lista')[0]!.click());
    await flush();
    expect(buttons('Repasar y pagar')[0]!.disabled).toBe(true);
    const start = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(start + 61_000);
    act(() => buttons('Volver a cargar la lista')[0]!.click());
    await flush();
    expect(text()).not.toContain('No sabemos si se apuntaron todos');
    expect(buttons('Repasar y pagar')[0]!.disabled).toBe(false);
    expect(createPayoutBatch).toHaveBeenCalledTimes(1);
  });

  it('tras el resultado, la pagada se desmarca aunque al recargar deba otra vez la misma cifra', async () => {
    const marta = GIRLS[0]!;
    vi.mocked(createPayoutBatch).mockResolvedValue({
      results: [{ operatorId: marta.id, status: 'PAID', payoutId: '00000000-0000-4000-8000-0000000000aa', totalCents: 30_000 }],
      paidCount: 1,
      paidCents: 30_000,
    });
    await mount(true);
    await payMarta();
    act(() => bodyButton('Entendido')!.click());
    await flush();
    // Nuevas comisiones: vuelve a deber 300,00 €, como antes.
    expect(text()).toContain('Marta');
    expect(text()).toContain('Marca a quién pagas');
    expect(boxes().find((b) => b.closest('label')?.textContent?.includes('Marta'))!.checked).toBe(false);
  });
});
