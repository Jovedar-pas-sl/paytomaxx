'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { CustomerScreenView } from '@nightpay/contracts';
import { Button, Logo, useWakeLock } from '@nightpay/ui';
import {
  currentDisplayToken,
  DisplayApiError,
  forgetDisplayToken,
  pairDisplay,
  setScreenTip,
  unpairThisDisplay,
} from '@/lib/customer-display-api';
import { askNfcPermission, nfcSupported } from '@/lib/nfc';
import {
  INITIAL_MEMORY,
  amountText,
  cardLine,
  expireMemory,
  idleHint,
  isOtherTip,
  nextMemory,
  otherTipOffered,
  tipBreakdown,
  tipButtonLabel,
  waitingHint,
  type PantallaMemory,
  type WaitingView,
} from '@/lib/pantalla-state';
import { CobroQr } from '../cobrar/CobroQr';
import { formatEur } from '@/lib/money';
import { TabletPin } from './TabletPin';
import { TipOther } from './TipOther';
import { usePantallaLive } from './use-pantalla-live';
import { useTabletFicha } from './use-tablet-ficha';
import s from './pantalla.module.css';

const UNPAIRED_NOTICE = 'Esta pantalla se ha desemparejado. Pide un código nuevo en el móvil del camarero.';

/**
 * «Pantalla del cliente» (/pantalla): la tablet (o un móvil viejo) de la
 * barra, mirando al cliente. Sin emparejar: el código que enseña el móvil
 * del camarero (Menú → Pantalla del cliente → Emparejar). Emparejada: el
 * reposo con el nombre del local, el importe y el QR del cobro que espera el
 * camarero, y «Pagado» unos segundos. Nunca el saldo ni quién cobra.
 */
export function PantallaCliente() {
  // undefined: aún sin mirar el almacenamiento (el servidor no lo tiene).
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setToken(currentDisplayToken()), []);

  const onUnpaired = useCallback(() => {
    forgetDisplayToken();
    setNotice(UNPAIRED_NOTICE);
    setToken(null);
  }, []);

  return (
    <main className={s.root} data-theme="dark">
      {token === undefined ? null : token ? (
        <Screen token={token} onUnpaired={onUnpaired} />
      ) : (
        <PairForm
          notice={notice}
          onPaired={(t) => {
            setNotice(null);
            setToken(t);
          }}
        />
      )}
    </main>
  );
}

function PairForm({ notice, onPaired }: { notice: string | null; onPaired: (token: string) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    if (code.replace(/[^a-z0-9]/gi, '').length < 6) return setError('Escribe las 6 letras y números del código.');
    setBusy(true);
    setError(null);
    // Con NFC (Android con Chrome): el permiso para leer fichas se pide ya, dentro de este toque.
    if (nfcSupported()) void askNfcPermission();
    try {
      onPaired((await pairDisplay(code)).token);
    } catch (err) {
      setError(err instanceof DisplayApiError ? err.message : 'No se ha podido emparejar. Vuelve a intentarlo.');
      setBusy(false);
    }
  }

  return (
    <div className={s.stage}>
      <form className={s.pair} onSubmit={(e) => void submit(e)}>
        <h1 className={s.pairTitle}>Pantalla del cliente</h1>
        {notice ? <p className={s.pairNotice}>{notice}</p> : null}
        <p className={s.pairText}>
          En el móvil del camarero: <strong>Menú → Pantalla del cliente → Emparejar</strong>. Escribe aquí el código que
          sale.
        </p>
        <input
          className={s.codeInput}
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 9))}
          placeholder="Código"
          aria-label="Código para emparejar"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
        />
        {error ? (
          <p className={s.error} role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="lg" loading={busy} loadingLabel="Emparejando">
          Emparejar
        </Button>
      </form>
    </div>
  );
}

function Screen({ token, onUnpaired }: { token: string; onUnpaired: () => void }) {
  const [venue, setVenue] = useState<{ name: string; fichas: boolean } | null>(null);
  const [mem, setMem] = useState<PantallaMemory>(INITIAL_MEMORY);
  const onView = useCallback((view: CustomerScreenView) => {
    setVenue({ name: view.venueName, fichas: view.fichas });
    setMem((m) => nextMemory(m, view, Date.now()));
  }, []);
  const { reachable, refresh } = usePantallaLive(token, onView, onUnpaired);
  // Emparejada: la pantalla no se apaga (si el navegador deja).
  useWakeLock(true);
  const waitingView = mem.shown.kind === 'waiting' ? mem.shown.view : null;
  // La ficha acercada a esta tablet (Web NFC): paga el cobro activo o pide aquí su PIN.
  const ficha = useTabletFicha(waitingView, refresh);
  const [tipBusy, setTipBusy] = useState(false);
  const chooseTip = useCallback(
    async (key: string, tipCents: number) => {
      setTipBusy(true);
      try {
        onView(await setScreenTip(key, tipCents));
      } catch (err) {
        ficha.setNote(err instanceof DisplayApiError ? err.message : 'No se ha podido elegir la propina.');
        refresh();
      } finally {
        setTipBusy(false);
      }
    },
    [onView, refresh, ficha.setNote],
  );

  // El «Pagado» y el texto corto se van solos.
  const until = 'until' in mem.shown ? mem.shown.until : null;
  useEffect(() => {
    if (until === null) return undefined;
    const t = setTimeout(() => setMem((m) => expireMemory(m, Date.now())), Math.max(0, until - Date.now()) + 20);
    return () => clearTimeout(t);
  }, [until]);

  const shown = mem.shown;
  return (
    <>
      {!reachable ? (
        <p className={s.offline} role="status">
          Sin conexión. Reintentando…
        </p>
      ) : null}
      <Corner onUnpaired={onUnpaired} nfc={ficha.needsPermission ? () => void ficha.enable() : null} />
      {ficha.note && shown.kind === 'waiting' ? (
        <p className={s.toast} role="status">
          {ficha.note}
        </p>
      ) : null}
      <div className={s.stage} aria-live="polite">
        {shown.kind === 'waiting' && ficha.pin ? (
          <TabletPin
            view={shown.view}
            step={ficha.pin}
            onPaid={() => {
              ficha.closePin();
              refresh();
            }}
            onClose={(note) => {
              ficha.closePin();
              if (note) ficha.setNote(note);
              refresh();
            }}
          />
        ) : shown.kind === 'waiting' ? (
          <Waiting
            view={shown.view}
            nfcHere={ficha.nfcHere}
            reading={ficha.busy}
            tipBusy={tipBusy}
            onTip={(cents) => void chooseTip(shown.view.key, cents)}
          />
        ) : shown.kind === 'paid' ? (
          <Paid />
        ) : venue ? (
          <Idle name={venue.name} fichas={venue.fichas} note={shown.note} />
        ) : null}
      </div>
    </>
  );
}

function Idle({ name, fichas, note }: { name: string; fichas: boolean; note: string | null }) {
  return (
    <>
      <div className={s.idle}>
        {note ? (
          <p className={s.note} role="status">
            {note}
          </p>
        ) : null}
        <h1 className={s.venue}>{name}</h1>
        <p className={s.idleHint}>{idleHint(fichas)}</p>
      </div>
      <div className={s.brand}>
        <Logo height="2rem" />
      </div>
    </>
  );
}

function Waiting({
  view,
  nfcHere,
  reading,
  tipBusy,
  onTip,
}: {
  view: WaitingView;
  nfcHere: boolean;
  reading: boolean;
  tipBusy: boolean;
  onTip: (cents: number) => void;
}) {
  const card = cardLine(view);
  const breakdown = tipBreakdown(view);
  return (
    <section className={s.waiting} aria-label="Cobro">
      <div className={s.amountBlock}>
        <p className={s.label}>{view.topUp ? 'Recarga de saldo' : 'Total'}</p>
        <p className={s.amount}>{amountText(view)}</p>
        {breakdown ? <p className={s.cardLine}>{breakdown}</p> : null}
        {card ? <p className={s.cardLine}>{card}</p> : null}
        {view.tip && !view.paying ? <TipChoice view={view} busy={tipBusy || reading} onTip={onTip} /> : null}
        <p className={s.hint}>
          {view.ficha && !view.paying ? <NfcIcon /> : null}
          {reading ? 'Leyendo la ficha…' : waitingHint(view, nfcHere)}
        </p>
        {view.ficha && view.qrUrl && !view.paying ? <p className={s.cardLine}>o escanea el QR con tu móvil</p> : null}
      </div>
      {view.paying ? (
        <div className={s.paying}>Pagando en el móvil del cliente…</div>
      ) : view.qrUrl ? (
        <div className={s.qrPlate}>
          <CobroQr value={view.qrUrl} fallbackPng={null} label="QR para pagar" />
        </div>
      ) : null}
    </section>
  );
}

/**
 * La propina: la elige el cliente, nada marcado de antemano («Sin propina» de
 * partida). Las sugeridas del local para este importe u «Otra» (teclado
 * grande, euros enteros hasta el tope); va al total, al QR y al cobro con
 * ficha (que entonces pide siempre el PIN).
 */
function TipChoice({ view, busy, onTip }: { view: WaitingView; busy: boolean; onTip: (cents: number) => void }) {
  const [typing, setTyping] = useState(false);
  const tip = view.tip;
  if (!tip) return null;
  const options = [{ cents: 0, label: 'Sin propina' }, ...tip.presets.map((p) => ({ cents: p.cents, label: tipButtonLabel(p) }))];
  const other = isOtherTip(view);
  return (
    <div className={s.tips}>
      <p className={s.tipsTitle}>¿Propina?</p>
      <div className={s.tipRow} role="radiogroup" aria-label="Propina">
        {options.map((o) => (
          <button
            key={o.cents}
            type="button"
            role="radio"
            aria-checked={tip.chosenCents === o.cents}
            className={s.tipBtn}
            data-on={tip.chosenCents === o.cents ? '1' : undefined}
            disabled={busy}
            onClick={() => tip.chosenCents !== o.cents && onTip(o.cents)}
          >
            {o.label}
          </button>
        ))}
        {otherTipOffered(view) ? (
          <button
            type="button"
            role="radio"
            aria-checked={other}
            className={s.tipBtn}
            data-on={other ? '1' : undefined}
            disabled={busy}
            onClick={() => setTyping(true)}
          >
            {other ? `Otra · +${formatEur(tip.chosenCents, { compact: true })}` : 'Otra'}
          </button>
        ) : null}
      </div>
      {tip.toStaff ? <p className={s.tipNote}>La propina va entera para el personal.</p> : null}
      {typing ? (
        <TipOther
          maxCents={tip.maxCents}
          initialCents={other ? tip.chosenCents : 0}
          busy={busy}
          onClose={() => setTyping(false)}
          onDone={(cents) => {
            setTyping(false);
            if (cents !== tip.chosenCents) onTip(cents);
          }}
        />
      ) : null}
    </div>
  );
}

function Paid() {
  return (
    <div className={s.paid} role="status">
      <svg className={s.tick} viewBox="0 0 48 48" fill="none" aria-hidden>
        <circle cx="24" cy="24" r="22" stroke="currentColor" strokeWidth="3" opacity="0.5" />
        <path d="M14 24.5l7 7 13-14" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <p className={s.paidWord}>Pagado</p>
      <p className={s.paidSub}>¡Gracias!</p>
    </div>
  );
}

/**
 * Menú discreto: pantalla completa, leer fichas en esta tablet (si Chrome aún
 * no dio permiso) y desemparejar (con confirmación: la tablet la tiene el
 * cliente delante).
 */
function Corner({ onUnpaired, nfc }: { onUnpaired: () => void; nfc: (() => void) | null }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [full, setFull] = useState(false);
  const canFull = typeof document !== 'undefined' && typeof document.documentElement.requestFullscreen === 'function';

  useEffect(() => {
    const onChange = () => setFull(Boolean(document.fullscreenElement));
    onChange();
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const close = () => {
    setOpen(false);
    setConfirming(false);
  };

  return (
    <div className={s.corner}>
      <button type="button" className={s.menuBtn} aria-label="Opciones de la pantalla" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>
      {open ? (
        <div className={s.menu}>
          {confirming ? (
            <>
              <p className={s.menuText}>¿Desemparejar esta pantalla? Para volver a usarla hará falta un código nuevo.</p>
              <Button
                variant="danger"
                onClick={() => {
                  close();
                  void unpairThisDisplay()
                    .catch(() => undefined)
                    .finally(onUnpaired);
                }}
              >
                Desemparejar
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                No, seguir
              </Button>
            </>
          ) : (
            <>
              {nfc ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    close();
                    nfc();
                  }}
                >
                  Leer fichas en esta tablet
                </Button>
              ) : null}
              {canFull ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    close();
                    if (full) void document.exitFullscreen().catch(() => undefined);
                    else void document.documentElement.requestFullscreen().catch(() => undefined);
                  }}
                >
                  {full ? 'Salir de pantalla completa' : 'Pantalla completa'}
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => setConfirming(true)}>
                Desemparejar
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function NfcIcon() {
  return (
    <svg className={s.hintIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M8.5 7.5a6 6 0 0 1 0 9" />
      <path d="M12 5a9.5 9.5 0 0 1 0 14" />
      <path d="M15.5 2.5a13 13 0 0 1 0 19" />
      <circle cx="5" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}
