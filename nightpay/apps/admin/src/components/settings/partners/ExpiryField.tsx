'use client';

import { Checkbox, Input } from '@nightpay/ui';
import type { PartnerScope } from '@nightpay/contracts';
import { expiryBounds, expiryRequired } from '@/lib/partner-connections';

/** La caducidad de la clave: de mañana a un año; sin caducidad, solo sin permisos de dinero. */
export function ExpiryField({
  scopes,
  day,
  noExpiry,
  onDay,
  onNoExpiry,
  disabled,
}: {
  scopes: readonly PartnerScope[];
  day: string;
  noExpiry: boolean;
  onDay: (day: string) => void;
  onNoExpiry: (noExpiry: boolean) => void;
  disabled?: boolean;
}) {
  const { min, max } = expiryBounds(new Date());
  const required = expiryRequired(scopes);
  return (
    <div className="np-ptn-fieldset">
      {required || !noExpiry ? (
        <Input
          type="date"
          label="Caduca el"
          value={day}
          min={min}
          max={max}
          onChange={(e) => onDay(e.target.value)}
          disabled={disabled}
          required
          hint={
            required
              ? 'De mañana a un año. Para cargar saldo es obligatoria: te avisamos 30 y 7 días antes.'
              : 'De mañana a un año. Te avisamos 30 y 7 días antes.'
          }
        />
      ) : null}
      {required ? null : (
        <Checkbox
          label="Sin caducidad"
          hint="Solo para ver el saldo. Mejor con fecha: si nadie la usa en 90 días, se duerme igual."
          checked={noExpiry}
          onChange={onNoExpiry}
          disabled={disabled}
        />
      )}
    </div>
  );
}
