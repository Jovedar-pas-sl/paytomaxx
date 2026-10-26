'use client';

import { useId } from 'react';
import { Input } from '@nightpay/ui';
import type { BusinessForm } from '@/lib/superadmin/forms';

interface Props {
  form: BusinessForm;
  onChange: (next: BusinessForm) => void;
  disabled?: boolean;
}

/** Datos de un negocio (alta y edición): una columna en el móvil, dos en grande. */
export function BusinessFields({ form, onChange, disabled }: Props) {
  const notesId = useId();
  const set = (key: keyof BusinessForm) => (e: { target: { value: string } }) =>
    onChange({ ...form, [key]: e.target.value });

  return (
    <div className="np-sa-grid-2">
      <Input
        label="Razón social"
        value={form.name}
        onChange={set('name')}
        placeholder="Luna Ocio SL"
        required
        maxLength={160}
        disabled={disabled}
      />
      <Input
        label="NIF / CIF"
        value={form.taxId}
        onChange={set('taxId')}
        placeholder="B12345678"
        maxLength={30}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
      />
      <Input
        label="Persona de contacto"
        value={form.contactName}
        onChange={set('contactName')}
        maxLength={120}
        disabled={disabled}
      />
      <Input
        label="Email de contacto"
        type="email"
        inputMode="email"
        value={form.contactEmail}
        onChange={set('contactEmail')}
        maxLength={254}
        disabled={disabled}
      />
      <Input
        label="Teléfono"
        type="tel"
        inputMode="tel"
        value={form.contactPhone}
        onChange={set('contactPhone')}
        maxLength={40}
        disabled={disabled}
      />
      <Input
        label="Comisión por defecto (%)"
        inputMode="decimal"
        value={form.commissionPct}
        onChange={set('commissionPct')}
        placeholder="La general (10 %)"
        hint="La que se queda la plataforma en los locales nuevos de este negocio."
        disabled={disabled}
      />
      <Input
        label="Comisión del servicio en los pagos con tarjeta (%)"
        inputMode="decimal"
        value={form.serviceFeePct}
        onChange={set('serviceFeePct')}
        placeholder="La de fábrica (10 %)"
        hint="La que paga el cliente encima en los locales nuevos de este negocio (de 0 a 12 %). Se enciende local a local."
        disabled={disabled}
      />
      <Input
        label="Comisión del servicio en las recargas (%)"
        inputMode="decimal"
        value={form.topUpServiceFeePct}
        onChange={set('topUpServiceFeePct')}
        placeholder="La de fábrica (10 %)"
        hint="La de las recargas del saldo en sus locales nuevos (de 0 a 12 %)."
        disabled={disabled}
      />
      <label htmlFor={notesId} className="np-sa-field np-sa-span-2">
        <span className="np-sa-label">Notas</span>
        <textarea
          id={notesId}
          className="np-sa-textarea"
          value={form.notes}
          onChange={set('notes')}
          rows={3}
          maxLength={4000}
          placeholder="Lo que haga falta recordar: condiciones, horarios, quién paga…"
          disabled={disabled}
        />
      </label>
    </div>
  );
}
