import type { CSSProperties } from 'react';

type LogoVariant = 'wordmark' | 'symbol';

interface LogoProps {
  /**
   * Alto de la caja del logo (CSS). Default 2rem. El wordmark ocupa ~60 % del
   * alto: así sale casi igual de ancho que el logo anterior y las cabeceras
   * no se mueven.
   */
  height?: string | number;
  /** `wordmark` (por defecto): símbolo + «oxiocard». `symbol`: solo el símbolo, en su loseta crema. */
  variant?: LogoVariant;
  /** Logo propio (p. ej. el de un local), relativo a `public/`: sustituye al de OxioCard. */
  src?: string;
  /** Alt text. Default 'OxioCard'. */
  alt?: string;
  /**
   * Solo con `src`: en el tema oscuro, el logo propio va sobre una placa
   * clara para que se lea. Defaults to true.
   */
  adaptiveBackdrop?: boolean;
}

/** Ficheros de la marca, en `public/brand/` de cada app. */
const BRAND = {
  /** Para fondo oscuro (crema con el punto lima). */
  wordmarkOnDark: '/brand/oxiocard-wordmark-claro.png',
  /** Para fondo claro (tinta con el punto lima). */
  wordmarkOnLight: '/brand/oxiocard-wordmark-oscuro.png',
  symbol: '/brand/oxiocard-simbolo.png',
  /** Tamaño real de los PNG (para reservar el hueco antes de que carguen). */
  wordmarkSize: { width: 269, height: 43 },
  symbolSize: 49,
} as const;

const WORDMARK_SHARE = 0.62;

/**
 * Logo de OxioCard. El wordmark cambia con el tema (data-theme en <html>):
 * claro sobre oscuro y oscuro sobre claro; las reglas están en styles.css
 * (.np-logo-img). Con `src`, el logo propio de siempre.
 */
export function Logo({
  height = '2rem',
  variant = 'wordmark',
  src,
  alt = 'OxioCard',
  adaptiveBackdrop = true,
}: LogoProps) {
  const h = typeof height === 'number' ? `${height}px` : height;

  if (src) {
    return (
      <span
        className={adaptiveBackdrop ? 'np-logo-bg' : undefined}
        style={{ ...wrap, height: `calc(${h} + 0.75rem)` }}
      >
        <img src={src} alt={alt} style={{ height: h, width: 'auto', display: 'block' }} decoding="async" />
      </span>
    );
  }

  if (variant === 'symbol') {
    return (
      <span style={{ ...wrap, ...symbolTile, width: h, height: h }}>
        <img
          src={BRAND.symbol}
          alt={alt}
          width={BRAND.symbolSize}
          height={BRAND.symbolSize}
          style={{ width: '62%', height: 'auto', display: 'block' }}
          decoding="async"
        />
      </span>
    );
  }

  const imgStyle: CSSProperties = { height: `calc(${h} * ${WORDMARK_SHARE})` };
  return (
    <span style={{ ...wrap, height: `calc(${h} + 0.75rem)` }}>
      <img
        className="np-logo-img"
        data-on="dark"
        src={BRAND.wordmarkOnDark}
        alt={alt}
        width={BRAND.wordmarkSize.width}
        height={BRAND.wordmarkSize.height}
        style={imgStyle}
        decoding="async"
      />
      <img
        className="np-logo-img"
        data-on="light"
        src={BRAND.wordmarkOnLight}
        alt={alt}
        width={BRAND.wordmarkSize.width}
        height={BRAND.wordmarkSize.height}
        style={imgStyle}
        decoding="async"
      />
    </span>
  );
}

const wrap: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 'var(--np-r-md)',
  transition: 'background var(--np-d-base), padding var(--np-d-base)',
  flexShrink: 0,
};

const symbolTile: CSSProperties = {
  borderRadius: '30%',
  background: 'var(--np-cream)',
};
