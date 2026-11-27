'use client';

import { useRef, useState, type FormEvent } from 'react';
import { Button, FormError, Input, Sheet } from '@nightpay/ui';
import { madridToday } from '@/lib/dates';
import {
  NOMBRE_PERIODO,
  diaCorto,
  etiquetaPeriodo,
  fechasValidas,
  nombreNoche,
  type NocheLista,
  type OpcionPeriodo,
  type Periodo,
} from '@/lib/periodos';
import { Notice } from './Notice';

/** «Otra noche…»: una de las 30 últimas (las que trae fetchNights()). */
const OTRAS = 30;

interface Props {
  value: Periodo;
  onChange: (next: Periodo) => void;
  opciones: readonly OpcionPeriodo[];
  /** Las noches de fetchNights() (null: aún no han llegado o fallaron). */
  nights: readonly NocheLista[] | null;
  /** La línea de debajo (lineaPeriodo, o lo que diga la pantalla). */
  linea?: string | null;
  /** Las noches no se pudieron cargar: el aviso y «Reintentar». */
  nightsError?: boolean;
  onRetry?: () => void;
  /** El botón de «Elegir fechas» («Ver»; en Informes, «Usar estas fechas»). */
  aplicar?: string;
  /** Lo que dice el botón en vez del periodo («Fechas del mapa»), con «Quitar». */
  override?: { label: string; onClear: () => void } | null;
}

/**
 * El selector de fechas, por noches (como cuenta el Z) o por días naturales:
 * «Esta noche ▾» abre una hoja (un menú junto al botón en ancho) con filas de
 * 48 px. Debajo, una línea que dice qué se está viendo.
 */
export function SelectorNoches({ value, onChange, opciones, nights, linea, nightsError = false, onRetry, aplicar = 'Ver', override = null }: Props) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'menu' | 'noches' | 'fechas'>('menu');
  const hoy = madridToday();
  const [desde, setDesde] = useState(value.clave === 'fechas' ? value.desde : hoy);
  const [hasta, setHasta] = useState(value.clave === 'fechas' ? value.hasta : hoy);
  const [invalid, setInvalid] = useState(false);

  const needsNights = opciones.includes('esta-noche');
  const label = override?.label ?? etiquetaPeriodo(value, nights ?? []);

  function show(): void {
    setView('menu');
    setInvalid(false);
    setOpen(true);
  }

  function pick(next: Periodo): void {
    setOpen(false);
    onChange(next);
  }

  function choose(option: OpcionPeriodo): void {
    if (option === 'noche') setView('noches');
    else if (option === 'fechas') setView('fechas');
    else pick({ clave: option });
  }

  function applyDates(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!fechasValidas(desde, hasta, madridToday())) {
      setInvalid(true);
      return;
    }
    pick({ clave: 'fechas', desde, hasta });
  }

  const selected = (option: OpcionPeriodo) => !override && value.clave === option;

  return (
    <div className="np-noches">
      <div className="np-noches-row">
        <span className="np-noches-anchor" ref={anchor}>
          <button type="button" className="np-noches-btn" aria-haspopup="dialog" aria-expanded={open} onClick={show}>
            {label} <span aria-hidden="true">▾</span>
          </button>
        </span>
        {override ? (
          <Button variant="ghost" size="sm" onClick={override.onClear}>
            Quitar
          </Button>
        ) : null}
      </div>
      {needsNights && nightsError ? (
        <div className="np-noches-error">
          <Notice tone="danger" action={onRetry ? { label: 'Reintentar', onClick: onRetry } : undefined}>
            No se pudieron cargar las noches
          </Notice>
        </div>
      ) : needsNights && nights === null && !override ? (
        <p className="np-noches-line" role="status">
          Cargando las noches…
        </p>
      ) : linea ? (
        <p className="np-noches-line">{linea}</p>
      ) : null}

      <Sheet open={open} onClose={() => setOpen(false)} title={view === 'fechas' ? 'Elegir fechas' : view === 'noches' ? 'Otra noche' : 'Fechas'} wide="menu" anchorRef={anchor}>
        {view === 'menu' ? (
          <ul className="np-noches-menu">
            {opciones.map((option) => (
              <li key={option}>
                <button type="button" className="np-noches-item" aria-pressed={selected(option)} onClick={() => choose(option)}>
                  {NOMBRE_PERIODO[option]}
                </button>
              </li>
            ))}
          </ul>
        ) : view === 'noches' ? (
          <ul className="np-noches-menu">
            {(nights ?? []).slice(0, OTRAS).map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className="np-noches-item"
                  aria-pressed={value.clave === 'noche' && value.id === n.id}
                  onClick={() => pick({ clave: 'noche', id: n.id })}
                >
                  Noche del {diaCorto(nombreNoche(n.openedAt))}
                  {n.closedAt ? '' : ' (abierta)'}
                </button>
              </li>
            ))}
            {nights && nights.length === 0 ? <li className="np-noches-line">Aún no abriste ninguna noche.</li> : null}
          </ul>
        ) : (
          <form className="np-noches-fechas" onSubmit={applyDates} noValidate>
            <Input label="Desde" type="date" value={desde} max={hoy} onChange={(e) => setDesde(e.target.value)} />
            <Input label="Hasta" type="date" value={hasta} max={hoy} min={desde || undefined} onChange={(e) => setHasta(e.target.value)} />
            {invalid ? <FormError>Elige un periodo válido: la fecha final después de la inicial y como mucho 366 días.</FormError> : null}
            <Button type="submit">{aplicar}</Button>
          </form>
        )}
      </Sheet>
    </div>
  );
}
