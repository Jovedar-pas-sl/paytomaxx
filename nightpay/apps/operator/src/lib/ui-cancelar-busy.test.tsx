import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// La hoja, sustituida: se guarda el onClose que recibe (el de la ✕, Esc, «atrás» y arrastrar).
const sheet = vi.hoisted(() => ({ onClose: null as null | (() => void) }));
vi.mock('@nightpay/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nightpay/ui')>()),
  Sheet: (props: { onClose: () => void }) => {
    sheet.onClose = props.onClose;
    return null;
  },
}));

import { CancelCobroConfirm } from '../components/CancelCobroConfirm';

describe('«¿Cancelar este cobro?» mientras cancela', () => {
  it('«Cancelando»: la ✕, Esc, «atrás» o arrastrar no la cierran (la compañera no cree que lo ha parado)', () => {
    const onClose = vi.fn();
    renderToStaticMarkup(<CancelCobroConfirm open atBank={false} busy onConfirm={() => undefined} onClose={onClose} />);
    sheet.onClose!();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('sin cancelar, sí se cierra', () => {
    const onClose = vi.fn();
    renderToStaticMarkup(<CancelCobroConfirm open atBank={false} busy={false} onConfirm={() => undefined} onClose={onClose} />);
    sheet.onClose!();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
