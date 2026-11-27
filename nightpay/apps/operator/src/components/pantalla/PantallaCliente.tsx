'use client';

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import type { CustomerScreenView } from '@nightpay/contracts';
import { Button, DoneMark, FormError, Icon, Importe, Logo, useWakeLock } from '@nightpay/ui';
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
  expireMemory,
  feeNote,
  idleHintText,
  isOtherTip,
  nextMemory,
  otherTipOffered,
  pricesOf,
  REST_SHIFT_MS,
  restOf,
  restShift,
  SCREEN_TEXT,
  tipBreakdown,
  tipButtonLabel,
  tipTotalBase,
  waitingHintText,
  type PantallaMemory,
  type RestView,
  type WaitingView,
} from '@/lib/pantalla-state';
import { CobroQr } from '../cobrar/CobroQr';
import { formatEur } from '@/lib/money';
import { tipDestination, type Bilingual } from '@/lib/pin-tip';
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
 * reposo con el nombre del local y su mensaje, el importe y el QR del cobro
 * que espera el camarero, y «Pagado» unos segundos. Nunca el saldo ni quién cobra.
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
          Esta tablet se pone en la barra mirando al cliente: le enseña cuánto paga y el QR de cada cobro, y entre cobros el nombre
          del local.
        </p>
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
  const [rest, setRest] = useState<RestView | null>(null);
  const [mem, setMem] = useState<PantallaMemory>(INITIAL_MEMORY);
  const onView = useCallback((view: CustomerScreenView) => {
    setRest(restOf(view));
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
      // Un toque: el error de antes se va.
      ficha.setProblem(null);
      try {
        onView(await setScreenTip(key, tipCents));
      } catch (err) {
        ficha.setProblem(err instanceof DisplayApiError ? err.message : 'No se ha podido elegir la propina.');
        refresh();
      } finally {
        setTipBusy(false);
      }
    },
    [onView, refresh, ficha.setProblem],
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
            onClose={(problem) => {
              ficha.closePin();
              // Otro cobro o ya pagado (el API): se queda bajo el importe.
              if (problem) ficha.setProblem(problem);
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
            problem={ficha.problem}
          />
        ) : shown.kind === 'paid' ? (
          <Paid cents={shown.cents} />
        ) : rest ? (
          <Idle rest={rest} note={shown.note} />
        ) : null}
      </div>
    </>
  );
}

/** El minuto de ahora (para el sitio del reposo): cambia cada REST_SHIFT_MS. */
function useRestStep(): number {
  const [step, setStep] = useState(() => Math.floor(Date.now() / REST_SHIFT_MS));
  useEffect(() => {
    const t = setInterval(() => setStep(Math.floor(Date.now() / REST_SHIFT_MS)), REST_SHIFT_MS);
    return () => clearInterval(t);
  }, []);
  return step;
}

/**
 * El reposo: el nombre del local en grande, su mensaje (si puso) y cómo se
 * paga. Todo se mueve un poco cada minuto (que no se quede marcado en la
 * pantalla): despacio, o de golpe con «reducir movimiento».
 */
function Idle({ rest, note }: { rest: RestView; note: string | null }) {
  const { x, y } = restShift(useRestStep());
  const drift = { '--rest-x': `${x}vmin`, '--rest-y': `${y}vmin` } as CSSProperties;
  return (
    <div className={s.rest} style={drift}>
      <div className={s.idle}>
        {note ? (
          <p className={s.note} role="status">
            {note}
          </p>
        ) : null}
        <h1 className={s.venue}>{rest.name}</h1>
        {rest.line1 ? (
          <div className={s.message}>
            <p className={s.messageMain} data-long={rest.line1.length > 60 ? '1' : undefined}>
              {rest.line1}
            </p>
            {rest.line2 ? <p className={s.messageSub}>{rest.line2}</p> : null}
          </div>
        ) : null}
        <p className={s.idleHint}>
          <Bi text={idleHintText(rest.fichas)} />
        </p>
      </div>
      <div className={s.brand}>
        <Logo height="2rem" />
      </div>
    </div>
  );
}

/** Un texto con su inglés debajo (idea 70): peso 500, más suave. */
function Bi({ text }: { text: Bilingual }) {
  return (
    <>
      {text.es}
      <span lang="en" className={s.en}>
        {text.en}
      </span>
    </>
  );
}

/**
 * El cobro que espera. Con «Comisión del servicio» (idea 70), los precios igual
 * de grandes (con saldo y con tarjeta) y la comisión con su importe antes de
 * elegir; sin comisión, un importe. Un error se queda debajo (FormError).
 */
export function Waiting({
  view,
  nfcHere,
  reading,
  tipBusy,
  onTip,
  problem,
}: {
  view: WaitingView;
  nfcHere: boolean;
  reading: boolean;
  tipBusy: boolean;
  onTip: (cents: number) => void;
  problem: string | null;
}) {
  const prices = pricesOf(view);
  const breakdown = prices ? null : tipBreakdown(view);
  return (
    <section className={s.waiting} aria-label="Cobro">
      <div className={s.amountBlock}>
        {prices ? (
          <>
            <div className={s.prices}>
              {prices.saldoCents !== null ? (
                <PriceBlock label={SCREEN_TEXT.withBalance} cents={prices.saldoCents} />
              ) : null}
              <PriceBlock label={SCREEN_TEXT.byCard} cents={prices.cardCents} />
            </div>
            <p className={s.feeNote}>
              <Bi text={feeNote(prices.feeCents)} />
            </p>
          </>
        ) : (
          <>
            <p className={s.label}>{view.topUp ? <Bi text={SCREEN_TEXT.topUp} /> : 'Total'}</p>
            <p className={s.amount}>{amountText(view)}</p>
          </>
        )}
        {breakdown ? <p className={s.cardLine}>{breakdown}</p> : null}
        {problem ? <FormError>{problem}</FormError> : null}
        {view.tip && !view.paying ? <TipChoice view={view} busy={tipBusy || reading} onTip={onTip} /> : null}
        <p className={s.hint}>
          {view.ficha && !view.paying ? <Icon name="nfc" size={28} className={s.hintIcon} /> : null}
          <span>
            <Bi text={reading ? SCREEN_TEXT.reading : waitingHintText(view, nfcHere)} />
          </span>
        </p>
        {view.ficha && view.qrUrl && !view.paying ? (
          <p className={s.cardLine}>
            <Bi text={SCREEN_TEXT.orQr} />
          </p>
        ) : null}
      </div>
      {view.paying ? (
        <div className={s.paying}>
          <span>
            <Bi text={SCREEN_TEXT.payingPhone} />
          </span>
        </div>
      ) : view.qrUrl ? (
        <div className={s.qrPlate}>
          <CobroQr value={view.qrUrl} fallbackPng={null} label="QR para pagar" />
        </div>
      ) : null}
    </section>
  );
}

/** Un precio: su etiqueta (con su inglés) y el importe, igual de grande que el otro. */
function PriceBlock({ label, cents }: { label: Bilingual; cents: number }) {
  return (
    <div className={s.priceBlock}>
      <p className={s.priceLabel}>
        <Bi text={label} />
      </p>
      <Importe cents={cents} className={s.price} />
    </div>
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
  // Debajo de cada propina, el total con ella (un precio); con dos precios, sin total.
  const base = tipTotalBase(view);
  const eur = (c: number) => formatEur(c, { compact: true });
  const options = [
    { cents: 0, label: SCREEN_TEXT.noTip as Bilingual | string, aria: 'Sin propina' },
    ...tip.presets.map((p) => ({ cents: p.cents, label: tipButtonLabel(p) as Bilingual | string, aria: `Propina de ${eur(p.cents)}` })),
  ];
  const other = isOtherTip(view);
  const to = tipDestination(tip.toStaff);
  return (
    <div className={s.tips}>
      <p className={s.tipsTitle}>
        <Bi text={SCREEN_TEXT.tip} />
      </p>
      <div className={s.tipRow} role="radiogroup" aria-label="Propina">
        {options.map((o) => (
          <button
            key={o.cents}
            type="button"
            role="radio"
            aria-checked={tip.chosenCents === o.cents}
            aria-label={base !== null ? `${o.aria}. Total ${eur(base + o.cents)}` : undefined}
            className={s.tipBtn}
            data-on={tip.chosenCents === o.cents ? '1' : undefined}
            disabled={busy}
            onClick={() => tip.chosenCents !== o.cents && onTip(o.cents)}
          >
            {typeof o.label === 'string' ? o.label : <Bi text={o.label} />}
            {base !== null ? <span className={s.tipTotal}>{eur(base + o.cents)}</span> : null}
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
            {other ? `Otra · +${eur(tip.chosenCents)}` : 'Otra'}
            <span lang="en" className={s.en}>
              {SCREEN_TEXT.other.en}
            </span>
          </button>
        ) : null}
      </div>
      <p className={s.tipNote}>
        <Bi text={to} />
      </p>
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

/** «Pagado», lo pagado (con tarjeta: con comisión y propina) y «¡Gracias!», con su inglés. */
export function Paid({ cents }: { cents: number | null }) {
  return (
    <div className={s.paid} role="status">
      <DoneMark className={s.tick} />
      <p className={s.paidWord}>
        <Bi text={SCREEN_TEXT.paid} />
      </p>
      {cents !== null ? <Importe cents={cents} className={s.paidAmount} /> : null}
      <p className={s.paidSub}>
        <Bi text={SCREEN_TEXT.thanks} />
      </p>
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
        <Icon name="dots" size={24} />
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
