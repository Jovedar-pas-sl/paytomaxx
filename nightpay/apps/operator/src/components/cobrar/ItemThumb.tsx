'use client';

import { useState } from 'react';
import { apiBase } from '@/lib/api';
import { cartaImageSrc } from '@/lib/carta-thumb';
import type { CartaItem } from '@/lib/cuenta';
import { ItemThumbView } from './ItemThumbView';

/** La imagen de un producto; si no carga, su icono (y no se vuelve a intentar con esa dirección). */
export function ItemThumb({ item }: { item: Pick<CartaItem, 'name' | 'icon' | 'category' | 'imageUrl'> }) {
  const src = cartaImageSrc(apiBase, item.imageUrl);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return <ItemThumbView item={item} src={src} failedSrc={failedSrc} onError={() => setFailedSrc(src)} />;
}
