import { CartaItemIcon } from '@nightpay/ui';
import { thumbKind, THUMB_SIZE } from '../../lib/carta-thumb';
import type { CartaItem } from '../../lib/cuenta';
import styles from './cobrar.module.css';

interface ViewProps {
  item: Pick<CartaItem, 'name' | 'icon' | 'category'>;
  /** Dirección de la imagen, o null (sin imagen: el icono). */
  src: string | null;
  /** La dirección que ya falló (sin red, 404 de una imagen cambiada…): sale el icono. */
  failedSrc?: string | null;
  onError?: () => void;
}

/**
 * El cuadrado de 52 px de la loseta (maqueta B): fondo crema y, dentro, la
 * imagen (contain) o el icono en tinta. El nombre va en el alt de la imagen; el
 * icono es decorativo (el nombre ya está al lado).
 */
export function ItemThumbView({ item, src, failedSrc = null, onError }: ViewProps) {
  const showImage = thumbKind(src, failedSrc) === 'image';
  return (
    <span className={styles.thumb} data-thumb={showImage ? 'image' : 'icon'}>
      {showImage ? (
        <img
          className={styles.thumbImg}
          src={src ?? undefined}
          alt={item.name}
          width={THUMB_SIZE}
          height={THUMB_SIZE}
          loading="lazy"
          decoding="async"
          onError={onError}
        />
      ) : (
        <CartaItemIcon item={item} size={26} />
      )}
    </span>
  );
}
