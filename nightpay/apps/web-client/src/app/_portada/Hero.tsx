import { cx } from './bits';
import { SHOTS } from './content';
import { Phone } from './Phone';
import h from './hero.module.css';
import s from '../landing.module.css';

/**
 * Arriba del todo, como el de oxiocard: fondo oscuro con la marca gigante y
 * translúcida detrás, titular a dos tonos, botón lima y tres móviles que
 * asoman por abajo (en lugar de sus tres tarjetas).
 */
export function Hero() {
  return (
    <section id="inicio" className={h.hero} aria-labelledby="hero-title">
      <div className={h.heroBg} aria-hidden="true">
        <span className={h.wm}>oxiopay</span>
      </div>
      <div className={cx(s.container, h.heroInner)}>
        <h1 id="hero-title" className={h.heroTitle}>
          <span className={s.dim}>Escanea, </span>paga desde tu móvil<span className={s.dim}> y sigue la noche</span>
        </h1>
        <p className={h.heroSub}>Sin app ni registro: con tarjeta, Apple Pay, Google Pay o tu saldo.</p>
        <p className={h.heroEn} lang="en">
          Scan the QR code the staff show you and pay from your phone.
        </p>
        <a className={cx(s.btn, s.btnLime, h.heroCta)} href="#contacto">
          ¿Tienes un local? Habla con nosotros
        </a>
      </div>
      <div className={h.heroPhones}>
        <Phone shot={SHOTS.saldo} className={cx(h.heroSide, h.heroLeft)} load="eager" />
        <Phone shot={SHOTS.pago} className={h.heroMain} load="high" />
        <Phone shot={SHOTS.pagado} className={cx(h.heroSide, h.heroRight)} load="eager" />
      </div>
    </section>
  );
}
