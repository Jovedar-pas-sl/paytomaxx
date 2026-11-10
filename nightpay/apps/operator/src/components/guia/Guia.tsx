import { GUIA_SECTIONS, guiaSituations, type GuiaSection } from '../../lib/guia';
import styles from './guia.module.css';

/**
 * La «Guía rápida» del personal (/guia): cómo cobrar, cómo cargar una ficha
 * y «Qué hago si…». Para leerla en el móvil, en oscuro (como la app), o
 * imprimirla desde el navegador (en claro y sin lo de navegar: guia.module.css).
 * Sin datos de nadie: las capturas son de la demo, con datos inventados.
 */
export function Guia() {
  const situations = guiaSituations();
  return (
    <main className={styles.page}>
      <nav className={styles.top} aria-label="Guía">
        <a href="/" className={styles.back}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14.5 5.5L8 12l6.5 6.5" />
          </svg>
          Volver a la app
        </a>
      </nav>

      <header className={styles.head}>
        <h1 className={styles.title}>Guía rápida</h1>
        <p className={styles.lead}>Cobrar, cargar una ficha y qué hacer si algo sale distinto, con las pantallas que vas a ver.</p>
        <ul className={styles.toc} aria-label="En esta guía">
          {GUIA_SECTIONS.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`}>{s.title}</a>
            </li>
          ))}
          <li>
            <a href="#si-pasa">Qué hago si…</a>
          </li>
        </ul>
      </header>

      {GUIA_SECTIONS.map((s) => (
        <Section key={s.id} section={s} />
      ))}

      <section id="si-pasa" className={styles.section} aria-labelledby="si-pasa-t">
        <h2 id="si-pasa-t" className={styles.h2}>
          Qué hago si…
        </h2>
        <dl className={styles.cases}>
          {situations.map((c) => (
            <div key={c.when}>
              <dt>{c.when}</dt>
              <dd>{c.todo}</dd>
            </div>
          ))}
        </dl>
      </section>

      <p className={styles.foot}>Las capturas son de una noche de prueba, con datos inventados.</p>
    </main>
  );
}

function Section({ section }: { section: GuiaSection }) {
  const titleId = `${section.id}-t`;
  return (
    <section id={section.id} className={styles.section} aria-labelledby={titleId}>
      <h2 id={titleId} className={styles.h2}>
        {section.title}
      </h2>
      {section.lead ? <p className={styles.sectionLead}>{section.lead}</p> : null}
      <ol className={styles.steps}>
        {section.steps.map((step) => (
          <li key={step.image} className={styles.step}>
            <p className={styles.stepText}>{step.text}</p>
            <img className={styles.shot} src={step.image} alt={step.alt} width={step.width} height={step.height} loading="lazy" decoding="async" />
          </li>
        ))}
      </ol>
    </section>
  );
}
