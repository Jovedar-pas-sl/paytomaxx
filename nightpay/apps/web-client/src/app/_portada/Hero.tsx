import { myBalanceUrl } from '@/lib/customer-pages';
import { cx } from './bits';
import { SHOTS } from './content';
import { Phone } from './Phone';
import h from './hero.module.css';
import s from '../landing.module.css';

/**
 * Arriba del todo, como el de oxiocard: fondo oscuro con la marca gigante y
 * translúcida detrás, titular a dos tonos, dos puertas y tres móviles que
 * asoman por abajo (en lugar de sus tres tarjetas). Las puertas (idea 73): el
 * cliente, «Ver mi saldo» (lima, al API: Face ID o huella); el local, «Tengo
 * un local» (a su sección). Debajo, con qué se paga.
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
        <div className={h.doors}>
          <a className={cx(s.btn, s.btnLime, s.btnBig, h.door)} href={myBalanceUrl()}>
            Ver mi saldo
          </a>
          <a className={cx(s.btn, s.btnLine, s.btnBig, h.door)} href="#locales">
            Tengo un local
          </a>
        </div>
        <p className={h.marks}>
          <img className={h.mark} src="/portada/marcas/visa.svg" height={28} alt="Visa" />
          <img className={h.mark} src="/portada/marcas/mastercard.svg" height={28} alt="Mastercard" />
          <img className={h.mark} src="/portada/marcas/Apple_Pay_Mark_RGB_041619.svg" height={28} alt="Apple Pay" />
        </p>
      </div>
      <div className={h.heroPhones}>
        <Phone shot={SHOTS.saldo} className={cx(h.heroSide, h.heroLeft)} load="eager" />
        <Phone shot={SHOTS.pago} className={h.heroMain} load="high" />
        <Phone shot={SHOTS.pagado} className={cx(h.heroSide, h.heroRight)} load="eager" />
      </div>
    </section>
  );
}
