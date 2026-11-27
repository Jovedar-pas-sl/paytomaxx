'use client';

import { useId, useState, type CSSProperties } from 'react';
import { Button, FieldError, Input } from '@nightpay/ui';
import { NO_DAYS, rangeProblem, type DayRange } from '@/lib/history';

interface Props {
  value: DayRange;
  onChange: (next: DayRange) => void;
}

/**
 * «Buscar por fechas»: un botón que abre desde y hasta qué noche (la de cada
 * día acaba a las 8:00 del siguiente). «Quitar fechas» lo deja como al entrar.
 */
export function DateRange({ value, onChange }: Props) {
  const active = value.fromDay !== '' || value.toDay !== '';
  const [open, setOpen] = useState(active);
  const problemId = useId();
  if (!open) {
    return (
      <div>
        <Button variant="ghost" size="md" onClick={() => setOpen(true)}>
          Buscar por fechas
        </Button>
      </div>
    );
  }
  const problem = rangeProblem(value);
  return (
    <div role="group" aria-label="Buscar por fechas" style={box}>
      <div style={row}>
        <Input
          label="Desde"
          type="date"
          style={dateStyle}
          value={value.fromDay}
          onChange={(e) => onChange({ ...value, fromDay: e.target.value })}
          aria-describedby={problem ? problemId : undefined}
          aria-invalid={problem ? true : undefined}
        />
        <Input
          label="Hasta"
          type="date"
          style={dateStyle}
          value={value.toDay}
          onChange={(e) => onChange({ ...value, toDay: e.target.value })}
          aria-describedby={problem ? problemId : undefined}
          aria-invalid={problem ? true : undefined}
        />
      </div>
      {problem ? (
        <FieldError id={problemId}>{problem}</FieldError>
      ) : (
        <p style={hintStyle}>Cada noche cuenta hasta las 8:00 del día siguiente.</p>
      )}
      {active ? (
        <div>
          <Button
            variant="ghost"
            size="md"
            onClick={() => {
              onChange(NO_DAYS);
              setOpen(false);
            }}
          >
            Quitar fechas
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const box: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.5rem', minWidth: 0 };
// Las dos fechas lado a lado en un móvil de 360 (cada una se encoge: minmax(0, 1fr)).
const row: CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '0.5rem' };
// El campo de fecha del iPhone trae un ancho mínimo propio: sin él, no se sale de su columna.
const dateStyle: CSSProperties = { minWidth: 0 };
const hintStyle: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-14)', color: 'var(--np-text-mute)', lineHeight: 1.4 };
