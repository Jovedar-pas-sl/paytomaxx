'use client';

import { useState, type CSSProperties } from 'react';
import { Button } from '@nightpay/ui';
import { HOME_TOPUP_PROBLEM_TEXT, type HomeTopUpSettings } from '@nightpay/contracts';
import { fetchHomeTopUp, rotateHomeTopUp, setHomeTopUp } from '@/lib/endpoints/home-topup';
import { homeTopUpPrintHtml, homeTopUpSummary } from '@/lib/home-topup';
import { LoadState, SettingsCard, StatusLine, Switch, useSavedFlash, useSettingsLoad } from './SettingsBits';

/**
 * Ajustes → Formas de cobro → «Cargar saldo desde casa» (dueño). Apagado de
 * serie. Encendido: el enlace del local y su QR para publicarlo (Instagram,
 * la web, WhatsApp) o imprimirlo; cualquiera con el enlace carga un saldo
 * nuevo. «Enlace nuevo» lo cambia si se publicó donde no debía (el de antes
 * deja de funcionar al momento).
 */
export function HomeTopUpPanel() {
  const { data, setData, error: loadError, retry } = useSettingsLoad(fetchHomeTopUp);
  const [busy, setBusy] = useState<'toggle' | 'rotate' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, flashSaved] = useSavedFlash();
  const [askRotate, setAskRotate] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!data) return <LoadState error={loadError} retry={retry} what="la carga de saldo desde casa" />;
  const settings: HomeTopUpSettings = data;

  async function run(what: 'toggle' | 'rotate', task: () => Promise<HomeTopUpSettings>): Promise<void> {
    setBusy(what);
    setError(null);
    try {
      setData(await task());
      setAskRotate(false);
      setCopied(false);
      flashSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function copy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError('No se ha podido copiar: selecciona el enlace y cópialo a mano.');
    }
  }

  function print(qr: string, url: string): void {
    const w = window.open('', '_blank', 'width=720,height=900');
    if (!w) return setError('El navegador no ha dejado abrir la hoja: permite las ventanas emergentes para imprimir.');
    w.document.write(homeTopUpPrintHtml(qr, url));
    w.document.close();
    w.focus();
    w.print();
  }

  const { url, qrPngDataUrl: qr } = settings;
  return (
    <SettingsCard
      title="Cargar saldo desde casa"
      hint="Un enlace del local para que el cliente cargue su saldo antes de llegar. Cualquiera con el enlace puede cargar: publícalo en Instagram, en vuestra web o en WhatsApp."
    >
      <Switch
        label="Cargar saldo desde casa"
        hint="Apagado, el enlace no funciona (se guarda para cuando lo vuelvas a encender)."
        checked={settings.enabled}
        disabled={busy !== null}
        onChange={(v) => void run('toggle', () => setHomeTopUp(v))}
      />
      {settings.enabled && url && qr ? (
        <div style={box}>
          {settings.problem ? (
            <p role="alert" className="np-set-error">
              {HOME_TOPUP_PROBLEM_TEXT[settings.problem]}
            </p>
          ) : null}
          <p className="np-set-note">{homeTopUpSummary(settings)}</p>
          <label style={labelStyle} htmlFor="homeTopUpUrl">
            Enlace del local
          </label>
          <div style={row}>
            <input id="homeTopUpUrl" readOnly value={url} style={urlStyle} onFocus={(e) => e.currentTarget.select()} />
            <Button variant="ghost" onClick={() => void copy(url)}>
              {copied ? 'Copiado' : 'Copiar'}
            </Button>
          </div>
          <img src={qr} alt="QR del enlace para cargar saldo desde casa" width={220} height={220} style={qrStyle} />
          <div style={row}>
            <a className="np-btn" data-variant="ghost" data-size="md" href={qr} download="cargar-saldo-qr.png">
              Descargar QR
            </a>
            <Button variant="ghost" onClick={() => print(qr, url)}>
              Imprimir
            </Button>
          </div>
          {askRotate ? (
            <div style={confirmBox} role="group" aria-label="Confirmar enlace nuevo">
              <p style={{ margin: 0 }}>
                El enlace y el QR de ahora dejan de funcionar al momento: tendrás que publicar el nuevo. Los saldos ya cargados no cambian.
              </p>
              <div style={row}>
                <Button variant="danger" loading={busy === 'rotate'} onClick={() => void run('rotate', rotateHomeTopUp)}>
                  Sí, enlace nuevo
                </Button>
                <Button variant="ghost" disabled={busy !== null} onClick={() => setAskRotate(false)}>
                  No
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" disabled={busy !== null} onClick={() => setAskRotate(true)}>
              Enlace nuevo
            </Button>
          )}
        </div>
      ) : null}
      <StatusLine saved={saved} error={error} />
    </SettingsCard>
  );
}

const box: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.75rem', paddingTop: '0.5rem' };
const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' };
const labelStyle: CSSProperties = { fontWeight: 600, fontSize: '0.9rem' };
const urlStyle: CSSProperties = {
  flex: '1 1 14rem',
  minWidth: 0,
  minHeight: '2.75rem',
  padding: '0 0.75rem',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  background: 'var(--np-surface-2, transparent)',
  color: 'inherit',
  font: 'inherit',
  fontSize: '0.85rem',
};
const qrStyle: CSSProperties = { alignSelf: 'flex-start', borderRadius: 'var(--np-r-md)', background: '#fff' };
const confirmBox: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.6rem',
  padding: '0.85rem 1rem',
  border: '1px solid var(--np-danger)',
  borderRadius: 'var(--np-r-md)',
};
