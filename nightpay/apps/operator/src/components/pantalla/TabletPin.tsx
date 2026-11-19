'use client';

import { DEFAULT_NIGHT_SETTINGS } from '@nightpay/contracts';
import { DisplayApiError, payScreenFichaPin } from '@/lib/customer-display-api';
import type { WaitingView } from '@/lib/pantalla-state';
import type { PinTipSetup } from '@/lib/pin-tip';
import { VenueNightContext } from '@/lib/venue-methods';
import { PinScreen } from '../cobrar/PinScreen';
import type { TabletPinStep } from './use-tablet-ficha';
import s from './pantalla.module.css';

/**
 * El PIN de la ficha, en la tablet y delante del cliente: la misma pantalla
 * del PIN que en el móvil del camarero (teclado del local, propina sin nada
 * marcado salvo la que ya eligió aquí). Sin nombres ni saldo: solo el importe.
 */
export function TabletPin({
  view,
  step,
  onPaid,
  onClose,
}: {
  view: WaitingView;
  step: TabletPinStep;
  onPaid: () => void;
  onClose: (note: string | null) => void;
}) {
  const tipSetup: PinTipSetup | null = view.tip
    ? { baseCents: view.amountCents, previousCents: view.tip.chosenCents, maxCents: view.tip.maxCents, presets: view.tip.presets }
    : null;
  return (
    <VenueNightContext.Provider
      value={{ ...DEFAULT_NIGHT_SETTINGS, pinKeypad: view.pinKeypad, nfcNoPinMaxCents: view.noPinMaxCents }}
    >
      <div className={s.pinWrap}>
        <PinScreen
          colors={[{ color: 'var(--np-lime)', weight: 1 }]}
          chip="Pagar con ficha"
          amountCents={view.amountCents}
          detail="Pon el PIN de tu ficha"
          tipSetup={tipSetup}
          reason={step.reason}
          onPin={async (pin, tipCents) => {
            try {
              await payScreenFichaPin(step.key, step.ficha, pin, tipCents);
              onPaid();
              return null;
            } catch (err) {
              // Otro cobro o ya pagado: fuera del PIN con el aviso; PIN mal: aquí mismo.
              if (err instanceof DisplayApiError && err.status === 409) {
                onClose(err.message);
                return null;
              }
              return err instanceof Error ? err.message : 'No se ha podido pagar.';
            }
          }}
          onCancel={() => onClose(null)}
        />
      </div>
    </VenueNightContext.Provider>
  );
}
