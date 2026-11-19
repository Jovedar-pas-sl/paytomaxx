'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button } from '@nightpay/ui';
import { fetchHomeTopUp } from '@/lib/endpoints/home-topup';
import { saveBlob } from '@/lib/save-file';
import { canvasToPng, drawSocialTemplate, loadBrandImages, SOCIAL_FORMATS, SOCIAL_PHRASES, type SocialFormat } from '@/lib/social-template';
import { counterTentHtml, doorStickersHtml, receptionPosterHtml, type KitOptions } from '@/lib/venue-kit';
import { useVenue } from '@/lib/venue-context';
import { SettingsCard, StatusLine, useSettingsLoad } from './SettingsBits';

type Sheet = (o: KitOptions) => string;

// Las mismas letras que el panel (packages/ui/fonts), sin copiarlas: el empaquetador da la URL con su hash.
const FONT_SANS = new URL('../../../../../packages/ui/fonts/instrument-sans.woff2', import.meta.url);
const FONT_NUM = new URL('../../../../../packages/ui/fonts/manrope-var.woff2', import.meta.url);
/** Tope de espera a las letras antes de imprimir. */
const FONT_WAIT_MS = 1500;

/**
 * Ajustes → Formas de cobro → «Material para el local» (dueño): tres hojas
 * A4 para imprimir (expositor de barra, pegatina de puerta, cartel de
 * recepción) y plantillas de imagen para las redes. El QR de las hojas es el
 * del enlace «Cargar saldo desde casa»: si está apagado, las hojas salen sin
 * QR. La foto del local no sale del navegador.
 */
export function VenueKitPanel() {
  const venue = useVenue();
  const { data } = useSettingsLoad(fetchHomeTopUp);
  const [error, setError] = useState<string | null>(null);

  const venueName = venue.name ?? venue.slug;
  const qr = data?.enabled && data.qrPngDataUrl ? data.qrPngDataUrl : null;

  function print(build: Sheet): void {
    const w = window.open('', '_blank', 'width=720,height=900');
    if (!w) return setError('El navegador no ha dejado abrir la hoja: permite las ventanas emergentes para imprimir.');
    setError(null);
    // La hoja se abre desde un blob: las URLs de las letras tienen que ser absolutas.
    const abs = (u: URL): string => new URL(u.pathname + u.search, window.location.origin).href;
    w.document.write(build({ venueName, qr, assetBase: window.location.origin, fonts: { sans: abs(FONT_SANS), num: abs(FONT_NUM) } }));
    w.document.close();
    w.focus();
    // Se imprime cuando han cargado imágenes y letras (con un tope de espera).
    w.addEventListener('load', () => {
      const wait = new Promise((r) => setTimeout(r, FONT_WAIT_MS));
      void Promise.race([w.document.fonts.ready, wait]).then(() => w.print());
    });
  }

  return (
    <SettingsCard
      title="Material para el local"
      hint="Hojas para imprimir y pegar en el local, y plantillas para publicar en redes. Todo en español y en inglés."
    >
      <p className="np-set-note">
        {qr ? 'Las hojas llevan el QR de «Cargar saldo desde casa».' : 'Sin el QR de «Cargar saldo desde casa» (está apagado): las hojas salen sin QR.'}
      </p>
      <div style={row}>
        <Button variant="ghost" onClick={() => print(counterTentHtml)}>
          Expositor de barra
        </Button>
        <Button variant="ghost" onClick={() => print(doorStickersHtml)}>
          Pegatina de puerta
        </Button>
        <Button variant="ghost" onClick={() => print(receptionPosterHtml)}>
          Cartel de recepción
        </Button>
      </div>
      <SocialGenerator venueName={venueName} onError={setError} />
      <StatusLine saved={false} error={error} />
    </SettingsCard>
  );
}

function SocialGenerator({ venueName, onError }: { venueName: string; onError: (m: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [format, setFormat] = useState<SocialFormat>('story');
  const [phrase, setPhrase] = useState<string>(SOCIAL_PHRASES[0]);
  const [photo, setPhoto] = useState<ImageBitmap | null>(null);

  // Se redibuja al cambiar formato, frase, nombre o foto.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    void (async () => {
      try {
        const brand = await loadBrandImages();
        if (!cancelled) await drawSocialTemplate(canvas, { format, phrase, venueName, photo, ...brand });
      } catch (err) {
        if (!cancelled) onError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [format, phrase, venueName, photo, onError]);

  async function pickPhoto(file: File | undefined): Promise<void> {
    if (!file) return setPhoto(null);
    try {
      setPhoto(await createImageBitmap(file));
    } catch {
      onError('No se ha podido abrir esa foto: prueba con otra (JPG o PNG).');
    }
  }

  async function download(): Promise<void> {
    if (!canvasRef.current) return;
    try {
      saveBlob(await canvasToPng(canvasRef.current), `oxiopay-${format === 'story' ? 'historia' : 'publicacion'}.png`);
    } catch (err) {
      onError((err as Error).message);
    }
  }

  const { w, h } = SOCIAL_FORMATS[format];
  return (
    <div style={box}>
      <p style={labelStyle}>Plantillas para redes</p>
      <div style={row} role="group" aria-label="Formato">
        {(Object.keys(SOCIAL_FORMATS) as SocialFormat[]).map((f) => (
          <Button key={f} variant={f === format ? 'primary' : 'ghost'} aria-pressed={f === format} onClick={() => setFormat(f)}>
            {SOCIAL_FORMATS[f].label}
          </Button>
        ))}
      </div>
      <label style={labelStyle} htmlFor="socialPhrase">
        Frase
      </label>
      <select id="socialPhrase" value={phrase} onChange={(e) => setPhrase(e.target.value)} style={selectStyle}>
        {SOCIAL_PHRASES.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <label style={labelStyle} htmlFor="socialPhoto">
        Foto del local (opcional)
      </label>
      <input id="socialPhoto" type="file" accept="image/*" onChange={(e) => void pickPhoto(e.target.files?.[0])} />
      <p className="np-set-note" style={{ margin: 0 }}>
        La foto se queda en este navegador: no se sube a ningún sitio.
      </p>
      <canvas ref={canvasRef} style={{ ...canvasStyle, aspectRatio: `${w} / ${h}` }} role="img" aria-label="Vista previa de la plantilla" />
      <div style={row}>
        <Button variant="ghost" onClick={() => void download()}>
          Descargar PNG
        </Button>
      </div>
    </div>
  );
}

const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' };
const box: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '0.5rem',
  padding: '0.75rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
};
const labelStyle: CSSProperties = { fontWeight: 600, fontSize: '0.875rem' };
const selectStyle: CSSProperties = {
  minHeight: '2.75rem',
  maxWidth: '100%',
  padding: '0 0.75rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  background: 'var(--np-surface-2, transparent)',
  color: 'inherit',
  font: 'inherit',
};
const canvasStyle: CSSProperties = { width: 'min(100%, 20rem)', height: 'auto', borderRadius: 'var(--np-r-md)', background: '#1f2c36' };
