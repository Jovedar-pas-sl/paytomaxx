'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { installHintOffered, installPlatform, isAppleMobile, installSnoozed, snoozeInstall, type InstallPlatform } from '../lib/install';

interface PromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice?: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true;
}

/*
 * Chrome ofrece instalar una sola vez por carga de página (beforeinstallprompt).
 * Se guarda aquí, para toda la app: si lo recoge la pantalla de entrar, el
 * menú del personal lo sigue teniendo después (sin recargar).
 */
let deferred: PromptEvent | null = null;
let installedNow = false;
const subscribers = new Set<() => void>();
let listening = false;

function listenOnce(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as PromptEvent;
    subscribers.forEach((f) => f());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installedNow = true;
    subscribers.forEach((f) => f());
  });
}

/**
 * Qué se puede hacer para instalar en este móvil y el botón de Android.
 * `platform` es null hasta que se sabe (en el servidor no se pinta nada).
 * `apple`: es un iPhone o un iPad (también con la app ya instalada).
 */
export function useInstall(): { platform: InstallPlatform | null; apple: boolean; install: () => Promise<boolean> } {
  const [platform, setPlatform] = useState<InstallPlatform | null>(null);
  const [apple, setApple] = useState(false);

  useEffect(() => {
    listenOnce();
    const update = () => {
      const env = { userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints ?? 0 };
      setApple(isAppleMobile(env));
      setPlatform(installPlatform({ ...env, standalone: installedNow || isStandalone(), hasPrompt: deferred !== null }));
    };
    update();
    subscribers.add(update);
    return () => {
      subscribers.delete(update);
    };
  }, []);

  const install = useCallback(async () => {
    const prompt = deferred;
    if (!prompt) return false;
    await prompt.prompt();
    const choice = await prompt.userChoice?.catch(() => undefined);
    // El aviso de Chrome vale una vez: usado (aceptado o no), se descarta.
    deferred = null;
    if (choice?.outcome === 'accepted') installedNow = true;
    subscribers.forEach((f) => f());
    return choice?.outcome === 'accepted';
  }, []);

  return { platform, apple, install };
}

/** Los pasos del iPhone, con el icono de Compartir dibujado. */
export function IosInstallSteps() {
  return (
    <span>
      En Safari, toca Compartir{' '}
      <Icon name="share" size={20} className="np-icon-lead" />
      <span className="np-sr-only">(el cuadrado con la flecha hacia arriba)</span> y luego «Añadir a pantalla de inicio».
    </span>
  );
}

/**
 * El aviso de instalar, para la pantalla de entrar (fuera del cobro: no
 * estorba). Se puede apartar («Ahora no») y no vuelve en 30 días; ya
 * instalada, o donde no se puede, no sale. `ios={false}`: en el iPhone y el
 * iPad no se ofrece (la app del personal: instalada, guarda sus datos aparte
 * de Safari y el cobro con ficha pasa por Safari).
 */
export function InstallHint({ appName = 'OxioPay', style, ios = true }: { appName?: string; style?: CSSProperties; ios?: boolean }) {
  const { platform, install } = useInstall();
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    setHidden(installSnoozed(Date.now()));
  }, []);

  if (hidden || !installHintOffered(platform, ios)) return null;

  const later = () => {
    snoozeInstall(Date.now());
    setHidden(true);
  };

  return (
    <aside style={{ ...card, ...style }} aria-label={`Instalar ${appName}`}>
      <b style={title}>Úsalo como una app</b>
      <p style={text}>
        A pantalla completa y con su icono en el móvil.{' '}
        {platform === 'ios' ? <IosInstallSteps /> : null}
      </p>
      <div style={actions}>
        {platform === 'prompt' ? (
          <Button size="md" variant="ghost" onClick={() => void install().then((ok) => ok && setHidden(true))}>
            Instalar
          </Button>
        ) : null}
        <Button size="md" variant="ghost" onClick={later}>
          {platform === 'ios' ? 'Entendido' : 'Ahora no'}
        </Button>
      </div>
    </aside>
  );
}

const card: CSSProperties = {
  display: 'grid',
  gap: '0.5rem',
  padding: '0.875rem 1rem',
  borderRadius: 'var(--np-r-md)',
  background: 'var(--np-surface)',
  boxShadow: 'inset 0 0 0 1px var(--np-border)',
  textAlign: 'left',
};
const title: CSSProperties = { fontSize: 'var(--np-fs-16)', fontWeight: 600, color: 'var(--np-text)' };
const text: CSSProperties = { margin: 0, fontSize: 'var(--np-fs-14)', lineHeight: 1.45, color: 'var(--np-text-mute)' };
const actions: CSSProperties = { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' };
