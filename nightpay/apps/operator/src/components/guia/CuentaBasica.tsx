import { CUENTA_BASICA, CUENTA_BASICA_SOURCES } from '../../lib/cuenta-basica';
import styles from './guia.module.css';

/**
 * «Cuenta de pago básica» (/cuenta-basica): para quien no tiene cuenta de
 * banco. Mismo aspecto que la «Guía rápida» (guia.module.css); se puede
 * imprimir desde el navegador.
 */
export function CuentaBasica() {
  return (
    <main className={styles.page}>
      <nav className={styles.top} aria-label="Cuenta de pago básica">
        <a href="/" className={styles.back}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14.5 5.5L8 12l6.5 6.5" />
          </svg>
          Volver a la app
        </a>
      </nav>

      <header className={styles.head}>
        <h1 className={styles.title}>Cuenta de pago básica</h1>
        <p className={styles.lead}>Si no tienes cuenta de banco, tienes derecho a abrir una sencilla. Así se pide.</p>
        <ul className={styles.toc} aria-label="En esta guía">
          {CUENTA_BASICA.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`}>{s.title}</a>
            </li>
          ))}
        </ul>
      </header>

      {CUENTA_BASICA.map((s) => (
        <section key={s.id} id={s.id} className={styles.section} aria-labelledby={`${s.id}-t`}>
          <h2 id={`${s.id}-t`} className={styles.h2}>
            {s.title}
          </h2>
          <div className={styles.cases}>
            {s.points.map((point) => (
              <div key={point}>
                <p style={{ margin: 0, lineHeight: 1.45 }}>{point}</p>
              </div>
            ))}
          </div>
        </section>
      ))}

      <p className={styles.foot}>{CUENTA_BASICA_SOURCES}</p>
    </main>
  );
}
