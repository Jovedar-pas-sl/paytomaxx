// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { createPayoutBatch } from '@/lib/api';
import { ApiError } from '@/lib/api-errors';
import { PayoutBatchReview, type BatchItem } from './PayoutBatchReview';

vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), createPayoutBatch: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = '00000000-0000-4000-8000-000000000002';
const B = '00000000-0000-4000-8000-000000000003';
const ITEMS: BatchItem[] = [
  { operatorId: A, name: 'Marta', method: 'SEPA_IBAN', accountMasked: 'ES12 •••• •••• 4821', cents: 100_000, holderWarning: 'El titular no se parece al nombre de la compañera («Marta»).' },
  { operatorId: B, name: 'Ana', method: 'USDT_TRC20', accountMasked: 'T…9f2a', cents: 84_000, bankHeldNote: 'No entra en este pago: 50,00\u00a0€.' },
];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  vi.mocked(createPayoutBatch).mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => undefined);
};
const text = () => document.body.textContent ?? '';
const button = (label: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label);
const confirmBox = () => document.querySelector<HTMLInputElement>('.np-hoja input[type="checkbox"]')!;
function typeCode(code: string) {
  const input = document.querySelector<HTMLInputElement>('.np-otp-input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, code);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

interface Props {
  items?: BatchItem[];
  method?: 'totp' | 'passkey' | null | undefined;
  onClose?: () => void;
  onDone?: (after: unknown) => void;
  open?: boolean;
}
function render({ items = ITEMS, method = 'totp', onClose = () => undefined, onDone = () => undefined, open = true }: Props = {}) {
  act(() => root.render(<PayoutBatchReview open={open} items={items} method={method} onClose={onClose} onDone={onDone} />));
}

const OK = (cents = 184_000) => ({
  results: ITEMS.map((i) => ({ operatorId: i.operatorId, status: 'PAID' as const, payoutId: '00000000-0000-4000-8000-0000000000aa', totalCents: i.cents })),
  paidCount: 2,
  paidCents: cents,
});

describe('el repaso', () => {
  it('enseña a quién, por dónde, cuánto, el aviso de titular, lo retenido y el total', () => {
    render();
    expect(text()).toContain('Repasa los 2 pagos');
    expect(text()).toContain('Transferencia · ES12 •••• •••• 4821');
    expect(text()).toContain('El titular no se parece al nombre de la compañera («Marta»).');
    expect(text()).toContain('No entra en este pago: 50,00\u00a0€.');
    expect(text()).toContain('1.840,00');
    expect(text()).toContain('Aquí apuntas pagos que ya has hecho por fuera.');
    expect(text()).toContain('Ya he pagado estos 2 importes, cada uno a su cuenta');
    expect(button('Apuntar 2 pagos')).toBeDefined();
    expect(button('Volver')).toBeDefined();
    expect(document.activeElement).toBe(confirmBox());
  });

  it('con una: en singular', () => {
    render({ items: [ITEMS[0]!] });
    expect(text()).toContain('Repasa el pago');
    expect(text()).toContain('Ya he pagado este importe a su cuenta');
    expect(button('Apuntar 1 pago')).toBeDefined();
  });

  it('sin la casilla no se envía (ni con el sexto número)', () => {
    render();
    typeCode('123456');
    expect(createPayoutBatch).not.toHaveBeenCalled();
    expect(button('Apuntar 2 pagos')!.disabled).toBe(true);
  });

  it('con la casilla, el sexto número envía las cifras vistas y la clave (sin importes ni cuentas)', async () => {
    vi.mocked(createPayoutBatch).mockResolvedValue(OK());
    render();
    act(() => confirmBox().click());
    typeCode('123456');
    await flush();
    expect(createPayoutBatch).toHaveBeenCalledTimes(1);
    const [items, opts] = vi.mocked(createPayoutBatch).mock.calls[0]!;
    expect(items).toEqual([
      { operatorId: A, expectedTotalCents: 100_000 },
      { operatorId: B, expectedTotalCents: 84_000 },
    ]);
    expect(opts.totpCode).toBe('123456');
    expect(opts.idempotencyKey).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(text()).toContain('2 pagos apuntados · 1.840,00\u00a0€');
  });

  it('con llave: KeyConfirm (sin campo del código) atado a la clave, a cuántas y al total', () => {
    render({ method: 'passkey' });
    expect(document.querySelector('.np-otp-input')).toBeNull();
    expect(text()).toMatch(/Confirmar con /);
    expect(text()).toContain('No tienes la verificación en dos pasos');
  });

  it('enviando: «Apuntando 2 pagos…», ni otro envío ni se cierra', async () => {
    let resolve: (v: ReturnType<typeof OK>) => void = () => undefined;
    vi.mocked(createPayoutBatch).mockImplementation(() => new Promise((r) => (resolve = r)));
    const onClose = vi.fn();
    render({ onClose });
    act(() => confirmBox().click());
    typeCode('123456');
    await flush();
    expect(text()).toContain('Apuntando 2 pagos…');
    act(() => (document.querySelector('button[aria-label="Cerrar"]') as HTMLButtonElement).click());
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    act(() => (document.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(onClose).not.toHaveBeenCalled();
    expect(createPayoutBatch).toHaveBeenCalledTimes(1);
    await act(async () => resolve(OK()));
  });

  it('código malo: se vacía y el siguiente va con la MISMA clave; otro repaso, clave nueva', async () => {
    vi.mocked(createPayoutBatch).mockRejectedValueOnce(new ApiError('Código incorrecto', 403, 'TOTP_INVALID')).mockResolvedValueOnce(OK());
    render();
    act(() => confirmBox().click());
    typeCode('111111');
    await flush();
    expect(text()).toContain('Código incorrecto');
    expect(document.querySelector<HTMLInputElement>('.np-otp-input')!.value).toBe('');
    typeCode('222222');
    await flush();
    const [first, second] = vi.mocked(createPayoutBatch).mock.calls;
    expect(second![1].idempotencyKey).toBe(first![1].idempotencyKey);

    // Cerrar y abrir otro repaso: clave nueva (un lote de otro día no se toma por repetición).
    render({ open: false });
    vi.mocked(createPayoutBatch).mockResolvedValueOnce(OK());
    render();
    act(() => confirmBox().click());
    typeCode('333333');
    await flush();
    expect(vi.mocked(createPayoutBatch).mock.calls[2]![1].idempotencyKey).not.toBe(first![1].idempotencyKey);
  });

  it('tras el resultado, «Entendido» recarga la lista (a medias, con la marca y el texto de cada una)', async () => {
    vi.mocked(createPayoutBatch).mockResolvedValue({
      results: [
        { operatorId: A, status: 'PAID', payoutId: '00000000-0000-4000-8000-0000000000aa', totalCents: 100_000 },
        { operatorId: B, status: 'FAILED', code: 'PAYOUT_CHANGED', totalCents: 90_000 },
      ],
      paidCount: 1,
      paidCents: 100_000,
    });
    const onDone = vi.fn();
    render({ onDone });
    act(() => confirmBox().click());
    typeCode('123456');
    await flush();
    expect(text()).toContain('Apuntados 1 de 2 · 1.000,00\u00a0€');
    expect(text()).toContain('Ahora son 900,00\u00a0€, no 840,00\u00a0€');
    act(() => button('Entendido')!.click());
    expect(onDone).toHaveBeenCalledWith({ notes: [{ operatorId: B, code: 'PAYOUT_CHANGED', totalCents: 90_000 }], untick: [A] });
  });

  it('409 PAYOUT_BATCH_CHANGED: el problema en su fila y «Volver a la lista» recarga', async () => {
    const { PayoutBatchChangedError } = await import('@/lib/api');
    vi.mocked(createPayoutBatch).mockRejectedValue(new PayoutBatchChangedError([{ operatorId: B, code: 'CASH' }]));
    const onDone = vi.fn();
    render({ onDone });
    act(() => confirmBox().click());
    typeCode('123456');
    await flush();
    expect(text()).toContain('Algo ha cambiado desde que abriste la lista: no se ha apuntado ningún pago nuevo.');
    expect(text()).toContain('Cobra en efectivo: se paga una a una');
    act(() => button('Volver a la lista')!.click());
    expect(onDone).toHaveBeenCalledWith({ notes: [{ operatorId: B, code: 'CASH' }] });
  });

  it('sin respuesta: «No sabemos si se apuntaron todos…», sin repetir, y «Volver a cargar la lista»', async () => {
    vi.mocked(createPayoutBatch).mockRejectedValue(new ApiError('red', 0));
    const onDone = vi.fn();
    render({ onDone });
    act(() => confirmBox().click());
    typeCode('123456');
    await flush();
    expect(text()).toContain('No sabemos si se apuntaron todos');
    expect(button('Apuntar 2 pagos')).toBeUndefined();
    act(() => button('Volver a cargar la lista')!.click());
    expect(onDone).toHaveBeenCalledWith({ notes: [], untick: [A, B], uncertain: true });
  });

  it('el encargado que ya pide: su texto y se cierra recargando', async () => {
    vi.mocked(createPayoutBatch).mockRejectedValue(new ApiError('lo que sea', 409, 'PAYOUT_BATCH_NEEDS_APPROVAL'));
    const onDone = vi.fn();
    render({ onDone });
    act(() => confirmBox().click());
    typeCode('123456');
    await flush();
    expect(onDone).toHaveBeenCalledWith({ notice: 'En este local los pagos del encargado los aprueba el dueño: pídelos uno a uno.' });
  });
});
