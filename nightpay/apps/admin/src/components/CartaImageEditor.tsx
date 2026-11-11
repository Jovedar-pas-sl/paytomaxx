'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button, CartaIcon, CartaItemIcon } from '@nightpay/ui';
import { CARTA_ICONS, cartaIconOf, type CartaIconCode } from '@nightpay/contracts';
import { API_BASE } from '@/lib/http';
import { removeServiceImage, updateServiceItem, uploadServiceImage, type ServiceItem } from '@/lib/api';
import { ACCEPTED_IMAGE_TYPES, reduceToWebp, type ReducedImage } from '@/lib/carta-image-resize';

/** La dirección completa de la imagen de un producto (el API está en otro origen). */
export function cartaImageUrl(item: Pick<ServiceItem, 'imageUrl'>): string | null {
  return item.imageUrl ? `${API_BASE.replace(/\/+$/, '')}${item.imageUrl}` : null;
}

/** El cuadrado crema de la carta: la imagen del producto o su icono. */
export function CartaThumb({ item, size = 44 }: { item: Pick<ServiceItem, 'name' | 'icon' | 'category' | 'imageUrl'>; size?: number }) {
  const src = cartaImageUrl(item);
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = src !== null && src !== failed;
  return (
    <span style={{ ...thumbBox, width: size, height: size }}>
      {showImage ? (
        <img src={src} alt={item.name} width={size} height={size} loading="lazy" style={thumbImg} onError={() => setFailed(src)} />
      ) : (
        <CartaItemIcon item={item} size={Math.round(size * 0.68)} />
      )}
    </span>
  );
}

/**
 * Icono e imagen de un producto de la carta: «Elegir icono» (rejilla de la
 * colección), «Subir logo o foto» (se recorta en cuadrado y se reduce a 128×128
 * WebP aquí, con vista previa antes de guardar) y «Quitar imagen».
 */
export function CartaImageEditor({ item, onChanged }: { item: ServiceItem; onChanged: () => void }) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ReducedImage | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  // La vista previa es una URL de objeto: se suelta al cambiarla o al cerrar.
  useEffect(() => {
    const url = pending?.previewUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [pending]);

  async function run(work: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await work();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      setPending(await reduceToWebp(file));
    } catch (err) {
      setPending(null);
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  const current = cartaIconOf(item);
  return (
    <div style={box}>
      <div style={topRow}>
        <CartaThumb item={item} size={64} />
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Button type="button" variant="ghost" size="sm" onClick={() => setPicking((v) => !v)} aria-expanded={picking}>
            Elegir icono
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => input.current?.click()}>
            Subir logo o foto
          </Button>
          {item.imageUrl ? (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => removeServiceImage(item.id))}>
              Quitar imagen
            </Button>
          ) : null}
        </div>
        <input
          ref={input}
          type="file"
          accept={ACCEPTED_IMAGE_TYPES.join(',')}
          hidden
          aria-label={`Logo o foto de ${item.name}`}
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
      </div>

      <p style={hint}>
        {item.imageUrl
          ? 'Lleva su logo o foto (se recorta en cuadrado y queda en 128×128). Si no carga, la app muestra el icono.'
          : 'Sin imagen: la app muestra el icono. Un logo o foto pequeña lo reemplaza.'}
      </p>

      {pending ? (
        <div style={previewRow} aria-label="Vista previa">
          <span style={{ ...thumbBox, width: 64, height: 64 }}>
            <img src={pending.previewUrl} alt={`Vista previa de ${item.name}`} width={64} height={64} style={thumbImg} />
          </span>
          <span style={hint}>{Math.max(1, Math.round(pending.blob.size / 1024))} KB · así se verá en la app.</span>
          <Button
            type="button"
            size="sm"
            loading={busy}
            onClick={() =>
              void run(async () => {
                await uploadServiceImage(item.id, pending.base64);
                setPending(null);
              })
            }
          >
            Guardar imagen
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setPending(null)}>
            Cancelar
          </Button>
        </div>
      ) : null}

      {picking ? (
        <div role="group" aria-label="Iconos de la carta" style={grid}>
          {CARTA_ICONS.map((icon) => {
            const selected = item.icon === icon.code;
            return (
              <button
                key={icon.code}
                type="button"
                title={icon.label}
                aria-label={icon.label}
                aria-pressed={selected}
                disabled={busy}
                style={{ ...iconBtn, ...(selected ? iconBtnOn : null) }}
                onClick={() => void run(() => updateServiceItem(item.id, { icon: icon.code as CartaIconCode }))}
              >
                <CartaIcon code={icon.code} size={28} />
              </button>
            );
          })}
        </div>
      ) : null}
      {picking && item.icon ? (
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => updateServiceItem(item.id, { icon: null }))}>
          Usar el icono de su sección ({CARTA_ICONS.find((i) => i.code === cartaIconOf({ category: item.category }))?.label})
        </Button>
      ) : null}
      {picking && !item.icon ? <p style={hint}>Ahora usa el icono de su sección: {CARTA_ICONS.find((i) => i.code === current)?.label}.</p> : null}

      {error ? (
        <p role="alert" style={{ color: 'var(--np-danger)', margin: 0 }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

const box: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--np-border)' };
const topRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' };
const previewRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' };
const hint: CSSProperties = { margin: 0, color: 'var(--np-text-mute)', fontSize: '0.9375rem' };
const thumbBox: CSSProperties = {
  flex: 'none',
  display: 'grid',
  placeItems: 'center',
  borderRadius: 12,
  background: 'var(--np-cream, #efe9df)',
  color: 'var(--np-ink, #1f2c36)',
  overflow: 'hidden',
};
const thumbImg: CSSProperties = { display: 'block', width: '100%', height: '100%', objectFit: 'contain' };
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(3.25rem, 1fr))', gap: '0.5rem' };
const iconBtn: CSSProperties = {
  height: '3.25rem',
  display: 'grid',
  placeItems: 'center',
  borderRadius: 12,
  border: '1px solid var(--np-border)',
  background: 'var(--np-cream, #efe9df)',
  color: 'var(--np-ink, #1f2c36)',
  cursor: 'pointer',
};
const iconBtnOn: CSSProperties = { outline: '3px solid var(--np-primary, #c7d301)', outlineOffset: 1 };
