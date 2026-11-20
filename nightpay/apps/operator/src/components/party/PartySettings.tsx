'use client';

import { useEffect, useState } from 'react';
import type { MyStall } from '@nightpay/contracts';
import { Button } from '@nightpay/ui';
import { authedFetch } from '@/lib/api';
import { applyDayMode, readDayMode } from '@/lib/day-mode';
import { loadMyStall, saveMyStallOpen } from '@/lib/party-my-stall';
import { PasskeySheet } from '../PasskeySheet';
import { ProfileSheet } from '../ProfileSheet';
import { GuiaMenuLink, InstallMenuItem } from '../staff-menu';
import s from './party.module.css';

const MODES = [
  { day: false, label: 'Noche' },
  { day: true, label: 'Día' },
] as const;

const OPEN_CHOICES = [
  { open: true, label: 'Abierta' },
  { open: false, label: 'Cerrada' },
] as const;

/**
 * OxioParty · «Ajustes»: la caseta de quien entra («Abierta» o «Cerrada», lo
 * que ven los asistentes), el «Modo día» de este móvil (para cobrar al sol) y
 * lo del menú de siempre (Mi perfil, la llave de acceso, instalar, la guía y
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
      <MyStallCard />
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

/** «Tu caseta»: abrirla o cerrarla para la lista de casetas de los asistentes. Sin caseta, no sale. */
export function MyStallCard({ initial = null }: { initial?: MyStall | null }) {
  const [stall, setStall] = useState<MyStall | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    void loadMyStall(authedFetch, ctrl.signal).then((next) => {
      if (!ctrl.signal.aborted) setStall(next);
    });
    return () => ctrl.abort();
  }, []);
  if (!stall) return null;

  async function choose(open: boolean): Promise<void> {
    if (busy || !stall || stall.openNow === open) return;
    setBusy(true);
    setError(null);
    try {
      setStall(await saveMyStallOpen(authedFetch, open));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={s.card} aria-labelledby="party-stall-title">
      <div>
        <h2 id="party-stall-title" className={s.settingsLabel}>
          {stall.name}
        </h2>
        <p className={s.fee}>Los asistentes ven en su pulsera si tu caseta está abierta ahora.</p>
      </div>
      <div className={s.methods} role="group" aria-label="Abierta ahora">
        {OPEN_CHOICES.map((c) => (
          <button key={c.label} type="button" className={s.segBtn} aria-pressed={stall.openNow === c.open} disabled={busy} onClick={() => void choose(c.open)}>
            {c.label}
          </button>
        ))}
      </div>
      {error ? (
        <p role="alert" className={s.error}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
