'use client';

import type { CSSProperties, ReactNode } from 'react';
import { Logo, SectionChip } from '@nightpay/ui';
import { pulseraText } from '@/lib/edition';
import { fichaDigits } from '@/lib/ficha-number';
import { codeBoxes, codeInput } from '@/lib/reception-desk';
import { MenuAvatar } from '../../my-profile';
import { useStaffMenu } from '../../staff-menu';
import s from './desk.module.css';

/**
 * Los campos de Recepción (Grafito): 52 px, 16/500 a la izquierda, filete de
 * 1 px que se ve (3,6:1) y radio 10, encima del estilo del <Input> de
 * @nightpay/ui (compartido; en size="lg", 72 px y 32/700). Aquí ningún campo
 * lleva `error`: el error va en su caja, debajo.
 */
export const DESK_FIELD: CSSProperties = {
  height: '3.25rem',
  fontSize: 'var(--np-fs-16)',
  fontWeight: 500,
  borderWidth: 1,
  borderColor: 'var(--np-border-hi)',
  borderRadius: 'var(--np-r-sm)',
};

/** Los iconos de las maquetas (trazo, currentColor). */
const ICONS = {
  back: <path d="M14.5 5.5L8 12l6.5 6.5" strokeWidth="2.2" strokeLinejoin="round" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" strokeWidth="2.4" strokeLinejoin="round" />,
  cash: (
    <>
      <rect x="2.5" y="6.5" width="19" height="11" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 9.5v.01M18 14.5v.01" />
    </>
  ),
  card: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="M3 10h18M7 15h4" />
    </>
  ),
  // Una moneda con la B de bitcoin (la marca del panel y del PAGADO).
  bitcoin: <path d="M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18ZM10 7.5v9M10 7.5h3a2 2 0 0 1 0 4h-3M10 11.5h3.5a2.5 2.5 0 0 1 0 5H10M11.5 6v1.5M11.5 16.5V18" />,
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" strokeLinejoin="round" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" strokeLinejoin="round" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  nfc: (
    <>
      <path d="M5.5 10.5a2 2 0 0 1 0 3" />
      <path d="M9 8a6 6 0 0 1 0 8" />
      <path d="M12.5 5.5a9.5 9.5 0 0 1 0 13" />
      <path d="M16 3a13 13 0 0 1 0 18" />
    </>
  ),
  chevron: <path d="M9.5 5.5L16 12l-6.5 6.5" strokeLinejoin="round" />,
  camera: (
    <>
      <path d="M4 8.5h3l1.5-2.5h7L17 8.5h3v10H4z" strokeLinejoin="round" />
      <circle cx="12" cy="13.5" r="3.25" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M11 18.5h2" />
    </>
  ),
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

interface HeadProps {
  title: string;
  /** «Sergio», «Sergio · recepción», «Para K7Q-4M2 · tiene 80 €». */
  sub: string;
  /** Volver (en los pasos de dentro); sin él, el símbolo de la marca. */
  onBack?: () => void;
  /** El chip de la derecha: la sección de recepción (Entradas) o «Recarga» a trazos. */
  chip: { section: string; label: string };
  /** Sin el menú del logo (el símbolo, quieto): mientras no se sabe si se cargó, no se sale por ahí. */
  noMenu?: boolean;
  /** El «?» con el tutorial de la pantalla (ScreenHelp), junto al logo. */
  help?: ReactNode;
  /** OxioParty: lo de la derecha en vez del chip («En línea»). */
  aside?: ReactNode;
}

/**
 * La cabecera de cada pantalla (4.x): símbolo o volver, título, quién y su
 * chip (punto y nombre: el color de la sección nunca va solo, así que ya no
 * hay franja de color debajo). Es la única de Recepción: el símbolo abre el
 * menú («Salir»), como en «Cobrar».
 */
export function DeskHead({ title, sub, onBack, chip, noMenu = false, help, aside }: HeadProps) {
  const menu = useStaffMenu();
  const openMenu = noMenu ? null : menu;
  return (
    <div className={s.head}>
      {onBack ? (
        <button type="button" className={s.back} onClick={onBack} aria-label="Atrás">
          <Icon name="back" />
        </button>
      ) : openMenu ? (
        <button type="button" className={s.logoBtn} onClick={openMenu} aria-label="Menú">
          <MenuAvatar />
        </button>
      ) : (
        <Logo variant="symbol" height="2.625rem" />
      )}
      {help}
      <div className={s.headText}>
        <b>{title}</b>
        <span>{sub}</span>
      </div>
      {aside ?? <SectionChip section={chip.section}>{chip.label}</SectionChip>}
    </div>
  );
}

/**
 * El NFC dibujado como glifo, sin tarjeta plata ni halo (Grafito). s: en una
 * fila, en su cuadro neutro; l: en el escenario, dentro de su aro de 1 px.
 */
export function NfcMark({ size }: { size: 's' | 'l' }) {
  return (
    <span className={size === 's' ? s.glyph : s.rings} aria-hidden="true">
      <Icon name="nfc" />
    </span>
  );
}

/**
 * El número impreso de la ficha en grande (A1): «0000 1013», en grupos de 4
 * y la parte que importa en negrita. El lector de pantalla lo oye entero.
 */
export function FichaNumber({ printed, className }: { printed: string; className?: string }) {
  return (
    <span className={`${s.fichaNum} ${className ?? ''}`}>
      <span className="np-sr-only">{pulseraText('Ficha')} nº {printed}</span>
      <span aria-hidden="true">
        {fichaDigits(printed).map((part, i) =>
          part.strong ? <b key={i}>{part.text}</b> : <span key={i} className={s.fichaWeak}>{part.text}</span>,
        )}
      </span>
    </span>
  );
}

interface RowProps {
  title: string;
  detail: string;
  check?: boolean;
  /** El número impreso de la ficha, en grande entre el título y el detalle (A1). */
  ficha?: string | null;
  /** Debajo: «Mira que es la que tienes en la mano», lo último que se cargó… */
  children?: ReactNode;
  /** Su marca para el tutorial (data-tour). */
  tour?: string;
}

/** La fila de la ficha leída (o del saldo): su glifo, qué es y el ✓. */
export function DeskRowView({ title, detail, check = true, ficha = null, children, tour }: RowProps) {
  return (
    <div className={s.det} data-tour={tour}>
      <NfcMark size="s" />
      <div className={s.grow}>
        <b>{title}</b>
        {ficha ? <FichaNumber printed={ficha} /> : null}
        <span>{detail}</span>
        {children}
      </div>
      {check ? (
        <span className={s.okc}>
          <Icon name="check" />
        </span>
      ) : null}
    </div>
  );
}

interface CodeProps {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  /** Para el lector de pantalla. */
  label?: string;
  autoFocus?: boolean;
}

/**
 * El código del saldo en seis casillas (K7Q-4M2). Debajo hay un campo de
 * verdad (transparente, encima): el teclado del móvil, pegar y el lector de
 * pantalla funcionan como siempre.
 */
export function CodeBoxes({ value, onChange, disabled, label = 'Código del saldo', autoFocus }: CodeProps) {
  const boxes = codeBoxes(value);
  const next = codeInput(value).length;
  return (
    <div className={s.code}>
      {boxes.slice(0, 3).map((c, i) => (
        <i key={i} data-next={i === next} aria-hidden="true">
          {c}
        </i>
      ))}
      <em aria-hidden="true">-</em>
      {boxes.slice(3).map((c, i) => (
        <i key={i + 3} data-next={i + 3 === next} aria-hidden="true">
          {c}
        </i>
      ))}
      <input
        className={s.codeInput}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(codeInput(e.target.value))}
        inputMode="text"
        autoCapitalize="characters"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        maxLength={7}
        disabled={disabled}
        autoFocus={autoFocus}
      />
    </div>
  );
}

interface BtnProps {
  kind: 'pri' | 'gho';
  icon?: IconName;
  label: string;
  /** El detalle de debajo («Lo metes en la caja»): entonces es una fila de 72 px. */
  small?: string | null;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  /** Su marca para el tutorial (data-tour). */
  tour?: string;
}

/**
 * Un solo botón: el de @nightpay/ui (principal lima de 56 px, secundario de
 * 48 con filete), a todo el ancho. Con su detalle, una fila de 72 px (icono,
 * etiqueta y detalle), igual para las dos opciones. Ocupado sigue en su color
 * (data-loading): está trabajando, no vacío; deshabilitado, neutro.
 */
export function DeskBtn({ kind, icon, label, small, onClick, disabled, busy, tour }: BtnProps) {
  const off = disabled || busy;
  if (small) {
    return (
      <button
        type="button"
        className={`${s.opt} ${kind === 'pri' ? s.optPri : ''}`}
        onClick={onClick}
        disabled={off}
        aria-busy={busy || undefined}
        data-loading={busy || undefined}
        data-tour={tour}
      >
        {icon ? <Icon name={icon} /> : null}
        <span className={s.optText}>
          <b>{busy ? 'Un momento…' : label}</b>
          {busy ? null : <small>{small}</small>}
        </span>
      </button>
    );
  }
  const head: ReactNode = icon ? (
    <span className={s.row}>
      <Icon name={icon} />
      {label}
    </span>
  ) : (
    label
  );
  return (
    <button
      type="button"
      className={`np-btn ${s.btn}`}
      data-variant={kind === 'pri' ? 'primary' : 'ghost'}
      data-size={kind === 'pri' ? 'lg' : 'md'}
      data-loading={busy || undefined}
      onClick={onClick}
      disabled={off}
      aria-busy={busy || undefined}
      data-tour={tour}
    >
      {busy ? 'Un momento…' : head}
    </button>
  );
}

/**
 * Un bloque de «¿Cómo paga?» (Grafito 3): grande, con su color (efectivo
 * verde, tarjeta azul), el icono arriba y el nombre y la aclaración abajo.
 * Va por parejas dentro de un `.methods`; ninguno viene marcado.
 */
export function MethodBlock({ method, icon, label, small, onClick, disabled, busy, tour }: {
  method: 'cash' | 'card';
  icon: IconName;
  label: string;
  small: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  tour?: string;
}) {
  return (
    <button
      type="button"
      className={`${s.method} np-press`}
      data-method={method}
      data-loading={busy || undefined}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-tour={tour}
      onClick={onClick}
    >
      <span className={s.methodIcon}>
        <Icon name={icon} />
      </span>
      <span className={s.methodText}>
        <b>{busy ? 'Un momento…' : label}</b>
        {busy ? null : <small>{small}</small>}
      </span>
    </button>
  );
}

/**
 * El aviso del mostrador (A3): se acercó otra ficha que la del cliente que se
 * atiende («Esa es la 1014, no la 1013»). Solo avisa: la pantalla sigue igual.
 */
export function CounterAviso({ text, className }: { text: string; className?: string }) {
  return (
    <p role="alert" className={`${s.aviso} ${className ?? ''}`}>
      <Icon name="nfc" />
      <span>{text}</span>
    </p>
  );
}

/** Una fila de lista de 52 px con su flecha («Escribir el código»). */
export function DeskRowLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className={s.rowLink} onClick={onClick}>
      {label}
      <Icon name="chevron" />
    </button>
  );
}
