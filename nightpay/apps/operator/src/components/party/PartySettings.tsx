'use client';

import { useEffect, useState } from 'react';
import { Button } from '@nightpay/ui';
import { applyDayMode, readDayMode } from '@/lib/day-mode';
import { PasskeySheet } from '../PasskeySheet';
import { ProfileSheet } from '../ProfileSheet';
import { GuiaMenuLink, InstallMenuItem } from '../staff-menu';
import s from './party.module.css';

const MODES = [
  { day: false, label: 'Noche' },
  { day: true, label: 'Día' },
] as const;

/**
 * OxioParty · «Ajustes»: el «Modo día» de este móvil (para cobrar al sol) y lo
 * del menú de siempre (Mi perfil, la llave de acceso, instalar, la guía y
 * «Salir»). El modo se guarda solo en este móvil.
 */
export function PartySettings({ onLogout }: { onLogout: () => void }) {
  const [day, setDay] = useState(false);
  const [profile, setProfile] = useState(false);
  const [passkeys, setPasskeys] = useState(false);
  useEffect(() => {
    setDay(readDayMode());
  }, []);

  function choose(next: boolean) {
    setDay(next);
    applyDayMode(next);
  }

  return (
    <div className={`${s.taquilla} ${s.settings}`}>
      <ProfileSheet open={profile} onClose={() => setProfile(false)} onLogout={onLogout} />
      <PasskeySheet open={passkeys} onClose={() => setPasskeys(false)} />
      <h1 className={s.settingsTitle}>Ajustes</h1>
      <section className={s.card} aria-labelledby="party-day-title">
        <div>
          <h2 id="party-day-title" className={s.settingsLabel}>
            Pantalla
          </h2>
          <p className={s.fee}>Modo día: más claro, para cobrar al sol. Solo en este móvil.</p>
        </div>
        <div className={s.methods} role="group" aria-label="Modo de la pantalla">
          {MODES.map((m) => (
            <button key={m.label} type="button" className={s.segBtn} aria-pressed={day === m.day} onClick={() => choose(m.day)}>
              {m.label}
            </button>
          ))}
        </div>
      </section>
      <div className={s.settingsList}>
        <Button variant="ghost" onClick={() => setProfile(true)}>
          Mi perfil
        </Button>
        <Button variant="ghost" onClick={() => setPasskeys(true)}>
          Llave de acceso
        </Button>
        <InstallMenuItem />
        <GuiaMenuLink />
        <Button variant="ghost" onClick={onLogout}>
          Salir
        </Button>
      </div>
    </div>
  );
}
