import {
  COBRO_STATES_HELP,
  COBROS_ACTIONS_HELP,
  COBROS_CASES_HELP,
  COBROS_COLUMNS_HELP,
  COBROS_HOWTO_SUMMARY,
  type HelpItem,
} from '@/lib/cobros-help';
import { Pill } from './Pill';

/**
 * «Cómo leer esta tabla», cerrado por defecto debajo del título de Cobros:
 * columnas, botones de cada fila, estados y «Si pasa esto → haz esto». Los
 * textos, en lib/cobros-help.ts. Estilos en styles/panel-help.css.
 */
export function CobrosHowTo() {
  return (
    <details className="np-howto">
      <summary>{COBROS_HOWTO_SUMMARY}</summary>
      <div className="np-howto-body">
        <HelpGroup title="Columnas" items={COBROS_COLUMNS_HELP} />
        <HelpGroup title="Botones de cada cobro" items={COBROS_ACTIONS_HELP} />
        <section className="np-howto-group">
          <h3>Estados</h3>
          <dl>
            {COBRO_STATES_HELP.map((s) => (
              <div key={s.label}>
                <dt>
                  <Pill tone={s.tone}>{s.label}</Pill>
                </dt>
                <dd>{s.text}</dd>
              </div>
            ))}
          </dl>
        </section>
        <HelpGroup title="Si pasa esto → haz esto" items={COBROS_CASES_HELP} cases />
      </div>
    </details>
  );
}

function HelpGroup({ title, items, cases }: { title: string; items: readonly HelpItem[]; cases?: boolean }) {
  return (
    <section className="np-howto-group" data-kind={cases ? 'cases' : undefined}>
      <h3>{title}</h3>
      <dl>
        {items.map((i) => (
          <div key={i.term}>
            <dt>{i.term}</dt>
            <dd>{i.text}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
