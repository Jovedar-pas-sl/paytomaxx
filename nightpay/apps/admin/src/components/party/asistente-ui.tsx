'use client';

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

/**
 * Piezas de día de OxioParty para Pulseras y Devoluciones (maquetas «Panel» y
 * «Cierre»): fondo crema, tarjetas blancas con filete, tinta y lima en el
 * botón principal, el coral solo en el punto de la marca. Cifras en Manrope
 * (--np-font-num), texto en Instrument Sans (--np-font-sans). Todo el texto
 * con 4,5:1 o más. Los estados (hover, foco, pulsado) van en la hoja de
 * abajo, con el prefijo pa- para no tocar el resto del panel.
 */

export const DAY_CSS = `
.pa-root{--pa-bg:#F3F1EC;--pa-surface:#FFFFFF;--pa-line:#E0DBD1;--pa-soft:#EEEAE2;--pa-ink:#14181B;--pa-t2:#3F474E;--pa-t3:#5C656D;--pa-lime:#C7D301;--pa-coral:#FF7A59;--pa-hi:#8C96A0;
  display:flex;flex-direction:column;gap:16px;color:var(--pa-ink);font-family:var(--np-font-sans,'Instrument Sans','Segoe UI',Arial,sans-serif)}
.pa-card{background:var(--pa-surface);border:1px solid var(--pa-line);border-radius:14px;padding:18px 20px;display:flex;flex-direction:column;gap:12px;min-width:0}
.pa-card h2{margin:0;font-family:var(--np-font-num,Manrope,sans-serif);font-size:18px;font-weight:800;letter-spacing:-.01em;color:var(--pa-ink)}
.pa-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 16px}
.pa-sub{margin:0;font-size:13px;line-height:1.45;color:var(--pa-t3)}
.pa-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:12px}
.pa-kpi{padding:16px 18px;border-radius:14px;border:1px solid var(--pa-line);background:var(--pa-surface);display:flex;flex-direction:column;gap:6px}
.pa-kpi p{margin:0}
.pa-kpi .l{font-size:13px;font-weight:600;color:var(--pa-t3)}
.pa-kpi .v{font-family:var(--np-font-num,Manrope,sans-serif);font-size:30px;line-height:1.05;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.pa-kpi .h{font-size:13px;line-height:1.4;color:var(--pa-t3)}
.pa-kpi.strong{background:var(--pa-ink);border-color:var(--pa-ink);color:#F4F2EC}
.pa-kpi.strong .l,.pa-kpi.strong .h{color:#B8C0C6}
.pa-kpi.strong .v{color:var(--pa-lime)}
.pa-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:40px;padding:0 14px;border-radius:10px;border:1px solid var(--pa-hi);background:var(--pa-surface);color:var(--pa-ink);font:inherit;font-size:14px;font-weight:700;cursor:pointer;white-space:nowrap;transition:transform .12s ease,background-color .12s ease}
.pa-btn:hover{background:var(--pa-soft)}
.pa-btn:active{transform:translateY(1px)}
.pa-btn:focus-visible,.pa-input:focus-visible,.pa-select:focus-visible{outline:3px solid var(--pa-ink);outline-offset:2px}
.pa-btn:disabled{cursor:not-allowed;background:var(--pa-soft);border-color:var(--pa-line);color:var(--pa-t3);transform:none}
.pa-btn.primary{background:var(--pa-ink);border-color:var(--pa-ink);color:var(--pa-lime)}
.pa-btn.primary:hover{background:#2A3036}
.pa-btn.primary:disabled{background:var(--pa-soft);border-color:var(--pa-line);color:var(--pa-t3)}
.pa-btn.sm{min-height:36px;padding:0 12px;font-size:13px}
.pa-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.pa-field label{font-size:13px;font-weight:600;color:var(--pa-t2)}
.pa-input,.pa-select{min-height:40px;padding:0 12px;border:1.5px solid var(--pa-hi);border-radius:10px;background:var(--pa-surface);color:var(--pa-ink);font:inherit;font-size:15px}
.pa-row{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px}
.pa-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;font-size:12px;font-weight:700;white-space:nowrap}
.pa-chip i{width:6px;height:6px;border-radius:50%;background:currentColor}
.pa-chip.ok{background:#E2F1E8;color:#1A5E3C}
.pa-chip.warn{background:#FFF8E8;color:#5E3E00}
.pa-chip.bad{background:#FFF4F0;color:#7A2210}
.pa-chip.mute{background:var(--pa-soft);color:var(--pa-t2)}
.pa-chip.ink{background:var(--pa-ink);color:#F4F2EC}
.pa-note{margin:0;padding:12px 14px;border-radius:10px;border:1px solid #EBD39A;background:#FFF8E8;color:#5A4710;font-size:13px;line-height:1.45}
.pa-msg{margin:0;padding:12px 14px;border-radius:10px;font-size:14px;line-height:1.45}
.pa-msg.ok{border:1px solid #B9DCC7;background:#EEF7F1;color:#1A5E3C}
.pa-msg.bad{border:1px solid #F2C9BC;background:#FFF4F0;color:#7A2210}
.pa-scroll{overflow-x:auto;margin:0 -4px;padding:0 4px}
.pa-table{width:100%;min-width:640px;border-collapse:collapse;font-size:14px}
.pa-table th{padding:8px 10px;text-align:left;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--pa-t3);border-bottom:1px solid var(--pa-line)}
.pa-table td{padding:12px 10px;border-top:1px solid var(--pa-soft);vertical-align:middle;color:var(--pa-ink)}
.pa-table td.n,.pa-table th.n{text-align:right;font-variant-numeric:tabular-nums}
.pa-table td.n{font-family:var(--np-font-num,Manrope,sans-serif);font-weight:800}
.pa-table .lab{font-family:var(--np-font-num,Manrope,sans-serif);font-weight:800;font-size:15px}
.pa-table .dim{color:var(--pa-t3);font-size:13px}
.pa-acts{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
.pa-counts{display:flex;flex-wrap:wrap;gap:8px}
.pa-count{display:flex;flex-direction:column;gap:2px;min-width:110px;padding:10px 14px;border-radius:12px;border:1px solid var(--pa-line);background:var(--pa-surface)}
.pa-count b{font-family:var(--np-font-num,Manrope,sans-serif);font-size:22px;font-weight:800;font-variant-numeric:tabular-nums}
.pa-count span{font-size:13px;font-weight:600;color:var(--pa-t3)}
.pa-empty{margin:0;padding:8px 0;color:var(--pa-t3);font-size:14px}
@media (prefers-reduced-motion:reduce){.pa-btn{transition:none}}
`;

/** La hoja de estilos de día (una por sección: repetida no hace nada). */
export function DayStyles() {
  return <style>{DAY_CSS}</style>;
}

export function DayCard(props: { title: string; aside?: ReactNode; children: ReactNode; labelId: string }) {
  return (
    <section className="pa-card" aria-labelledby={props.labelId}>
      <div className="pa-head">
        <h2 id={props.labelId}>{props.title}</h2>
        {props.aside}
      </div>
      {props.children}
    </section>
  );
}

export function Kpi(props: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className={props.strong ? 'pa-kpi strong' : 'pa-kpi'}>
      <p className="l">{props.label}</p>
      <p className="v">{props.value}</p>
      {props.hint ? <p className="h">{props.hint}</p> : null}
    </div>
  );
}

export type ChipTone = 'ok' | 'warn' | 'bad' | 'mute' | 'ink';

export function Chip(props: { tone: ChipTone; children: ReactNode }) {
  return (
    <span className={`pa-chip ${props.tone}`}>
      <i aria-hidden="true" />
      {props.children}
    </span>
  );
}

export function DayButton({ variant, size, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost'; size?: 'sm' }) {
  const cls = ['pa-btn', variant === 'primary' ? 'primary' : '', size === 'sm' ? 'sm' : '', className ?? ''].filter(Boolean).join(' ');
  return <button type="button" {...rest} className={cls} />;
}

export function DayField(props: { id: string; label: string } & InputHTMLAttributes<HTMLInputElement>) {
  const { id, label, ...rest } = props;
  return (
    <div className="pa-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="pa-input" {...rest} />
    </div>
  );
}

export function DaySelect(props: { id: string; label: string; children: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>) {
  const { id, label, children, ...rest } = props;
  return (
    <div className="pa-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="pa-select" {...rest}>
        {children}
      </select>
    </div>
  );
}

/** Un aviso del resultado (ok) o de un error (bad), que se lee al aparecer. */
export function DayMessage(props: { tone: 'ok' | 'bad'; children: ReactNode }) {
  return (
    <p className={`pa-msg ${props.tone}`} role={props.tone === 'bad' ? 'alert' : 'status'}>
      {props.children}
    </p>
  );
}
