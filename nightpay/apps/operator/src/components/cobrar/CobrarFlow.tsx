'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, ThemeToggle } from '@nightpay/ui';
import type { InvitationRules } from '@nightpay/contracts';
import { fetchTerminals, newIdempotencyKey, type CreatedPayment, type MyNight, type OperatorUser } from '@/lib/api';
import { cancelCard, cancelSaldo, createCobro, createSaldoCobro, fetchInvitationRules, type CobroInput } from '@/lib/api-cobro';
import { tapOf } from '@/lib/carta-tiles';
import { arrivedTooLate, cancelTargetOf } from '@/lib/cobro-attempt';
import { invitationSplit, splitCells, whoLine } from '@/lib/cobro-view';
import {
  EMPTY_CUENTA,
  PROPINAS,
  addAmount,
  addItem,
  chargeLinesOf,
  cuentaTotals,
  cuentaWhat,
  removeLine,
  setQty,
  type CartaItem,
  type Cuenta,
  type CuentaSection,
} from '@/lib/cuenta';
import { useMySections } from '@/lib/sections';
import { useVenueMethods, useVenueNight } from '@/lib/venue-methods';
import { nfcSupported } from '@/lib/nfc';
import { ActivePayment } from '../ActivePayment';
import { useCarta } from '../carta';
import { Carta } from './Carta';
import { labelOf, type CobrarContext } from './cobrar-context';
import { ElegirChica } from './ElegirChica';
import { EscanearChica, type Invitada } from './EscanearChica';
import { Esperando, type CobroAbierto } from './Esperando';
import { IconPlus, IconQr } from './icons';
import { LaCuenta } from './LaCuenta';
import { MiQr } from './MiQr';
import { OtroImporte } from './OtroImporte';
import styles from './cobrar.module.css';

type Stage =
  | { kind: 'carta' }
  | { kind: 'otro' }
  | { kind: 'cuenta' }
  | { kind: 'escanear'; invite: CartaItem }
  | { kind: 'lista'; invite: CartaItem }
  | { kind: 'esperando'; cobro: CobroAbierto; request: Pending }
  | { kind: 'pos'; payment: CreatedPayment; label: string };

/** Lo que se pidió (para «Otro QR · mismo importe») y si era la cuenta (se vacía al pagarse). */
interface Pending {
  input: Omit<CobroInput, 'idempotencyKey'>;
  fromCuenta: boolean;
  view: Omit<CobroAbierto, 'card' | 'saldo' | 'saldoQr' | 'ref'>;
}

interface Props {
  user: OperatorUser;
  /** Pagado o vuelta a la carta: refrescar lo de la chica. */
  onCobroDone: () => void;
  onLogout: () => void;
  /** La noche de la chica (sus invitaciones, en «Mi QR»). */
  night?: MyNight | null;
  /** Abrir «Mi QR» desde fuera (la chica). */
  miQrOpen?: boolean;
  onMiQr?: (open: boolean) => void;
  /** «Recargar saldo» (maquetas 4.6–4.7): solo quien carga saldos (recepción, encargado, dueño). */
  onRecargar?: () => void;
}

/**
 * «Cobrar» (maquetas 1.1–1.4, 2.2–2.5, 3.1–3.4): la carta en losetas, la
 * cuenta, «Otro importe» y, al cobrar, un solo cobro que se paga con la
 * tarjeta (QR) o con el saldo (NFC, su PIN o su Face ID): gana el primero.
 * «Copa» es la copa normal: se suma a la cuenta sin preguntar nada. «Copa con
 * invitación» (una loseta más) escanea el QR de la chica y se cobra aparte,
 * repartida entre ella y el local. Con datáfono solo si el local lo tiene. Si
 * se sale de la invitación («Atrás») mientras se crea su cobro, no se abre
 * «Esperando» y se cancela (lib/cobro-attempt).
 */
export function CobrarFlow({ user, onCobroDone, onLogout, night, miQrOpen = false, onMiQr, onRecargar }: Props) {
  const mine = useMySections();
  const methods = useVenueMethods();
  const nightSettings = useVenueNight();
  const carta = useCarta();
  const [rules, setRules] = useState<InvitationRules | null>(null);
  const [terminals, setTerminals] = useState<Array<{ externalId: string }>>([]);
  const [stage, setStage] = useState<Stage>({ kind: 'carta' });
  const [cuenta, setCuenta] = useState<Cuenta>(EMPTY_CUENTA);
  const [busy, setBusy] = useState(false);
  /** Lo mismo que `busy`, al momento: el escáner llama con un render de antes (su `busy` puede ser viejo). */
  const busyNow = useRef(false);
  /** Cada cambio de pantalla, uno más: así se sabe si se salió de la invitación mientras se cobraba. */
  const screen = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const attempt = useRef<{ key: string; what: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchInvitationRules()
      .then((r) => !cancelled && setRules(r))
      .catch(() => undefined);
    fetchTerminals()
      .then((t) => !cancelled && setTerminals(t))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const ctx: CobrarContext = useMemo(
    () => ({
      user,
      sections: mine.sections,
      allowed: mine.allowed,
      post: mine.post ?? null,
      defaultCategory: mine.defaultCategory,
      tips: mine.tips !== false,
      methods,
      night: nightSettings,
      rules,
      carta: carta.services,
      cartaLoaded: carta.loaded,
      cartaFailed: carta.failed,
    }),
    [user, mine, methods, nightSettings, rules, carta.services, carta.loaded, carta.failed],
  );
  const who = whoLine(user.displayName, user.role);
  const name = user.displayName?.trim() || who;
  const nfc = methods.wallet && methods.nfc && nfcSupported();

  /** Crea el cobro (único: tarjeta + saldo; o solo saldo si el local no cobra con tarjeta). */
  const open = useCallback(
    async (pending: Pending, key: string): Promise<CobroAbierto> => {
      const totals = pending.view.totalCents;
      if (methods.card) {
        const created = await createCobro({ ...pending.input, terminalExternalId: terminals[0]?.externalId, idempotencyKey: key });
        return { ...pending.view, totalCents: totals, card: created, saldo: created.saldo ?? null, ref: created.ref ?? null };
      }
      if (methods.wallet) {
        const s = await createSaldoCobro(pending.input);
        return {
          ...pending.view,
          card: null,
          saldo: { chargeId: s.id, expiresAt: s.expiresAt },
          saldoQr: s.qrPngDataUrl,
          ref: s.ref,
        };
      }
      throw new Error('Este local no tiene ninguna forma de cobro encendida. Habla con el encargado.');
    },
    [methods.card, methods.wallet, terminals],
  );

  /** Cambiar de pantalla (siempre por aquí: cuenta las vueltas de `screen`). */
  const go = useCallback((next: Stage) => {
    screen.current += 1;
    setStage(next);
  }, []);

  /** Una invitación que llegó cuando ya se había salido de su pantalla: se cancela sin enseñarla. */
  async function dropCobro(cobro: CobroAbierto): Promise<void> {
    const target = cancelTargetOf(cobro);
    if (!target) return;
    try {
      if (target.kind === 'card') await cancelCard(target.id);
      else await cancelSaldo(target.id);
    } catch {
      setError('La invitación que dejaste a medias no se ha podido cancelar: caduca sola en unos minutos (nadie ve su QR).');
    }
  }

  /** true si se abrió el cobro (pasa a «Esperando»); false si no (sin red, o aún va otro). */
  async function start(pending: Pending): Promise<boolean> {
    if (busyNow.current) return false;
    busyNow.current = true;
    const what = JSON.stringify(pending.input);
    if (attempt.current?.what !== what) attempt.current = { key: newIdempotencyKey(), what };
    const asked = { invitation: pending.view.invitation !== null, screen: screen.current };
    setBusy(true);
    setError(null);
    try {
      if ('vibrate' in navigator) navigator.vibrate(10);
      const cobro = await open(pending, attempt.current.key);
      attempt.current = null;
      if (arrivedTooLate(asked, screen.current)) {
        await dropCobro(cobro);
        return false;
      }
      go({ kind: 'esperando', cobro, request: pending });
      return true;
    } catch (err) {
      if (!arrivedTooLate(asked, screen.current)) setError((err as Error).message);
      return false;
    } finally {
      busyNow.current = false;
      setBusy(false);
    }
  }

  /** La cuenta → el cobro. */
  function cobrarCuenta(c: Cuenta = cuenta) {
    const totals = cuentaTotals(c);
    const sections = totals.bySection;
    const what = cuentaWhat(c);
    const top = [...sections].sort((a, b) => b.cents - a.cents)[0]?.section ?? 'VENUE_BAR';
    void start({
      input: { lines: chargeLinesOf(c), tipCents: totals.tipCents },
      fromCuenta: true,
      view: {
        totalCents: totals.totalCents,
        sections,
        band: {
          title: sections
            .slice(0, 2)
            .map((s) => labelOf(ctx, s.section))
            .join(' + ')
            .toUpperCase(),
          detail: `${what} · ${name}`,
        },
        what,
        who: name,
        pinChip: `${labelOf(ctx, top)} · ${name}`,
        invitation: null,
      },
    });
  }

  /** «Copa con invitación» con la chica leída (o elegida): un cobro aparte (la cuenta no se toca). */
  function invitar(invite: CartaItem, chica: Invitada): Promise<boolean> {
    const split = rules ? invitationSplit(rules, invite.priceCents, user.role === 'WAITER') : null;
    const cells = split ? splitCells(split, { chica: chica.name, barra: `Barra (${name})` }) : [];
    return start({
      input: {
        lines: [{ serviceItemId: invite.id, qty: 1 }],
        ...(chica.token ? { invitedStaffToken: chica.token } : { invitedOperatorId: chica.id }),
      },
      fromCuenta: false,
      view: {
        totalCents: invite.priceCents,
        sections: [{ section: invite.category, cents: invite.priceCents }],
        band: { title: 'Invitación', detail: `${chica.name} · ${name}` },
        what: 'Invitación',
        who: name,
        pinChip: `${labelOf(ctx, invite.category)} · ${name}`,
        invitation: { chica: chica.name, cells },
      },
    });
  }

  async function retry() {
    if (stage.kind !== 'esperando' || retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const cobro = await open(stage.request, newIdempotencyKey());
      go({ kind: 'esperando', cobro, request: stage.request });
    } catch (err) {
      setRetryError((err as Error).message);
    } finally {
      setRetrying(false);
    }
  }

  const paidOnce = useRef<string | null>(null);
  const onPaid = useCallback(() => {
    if (stage.kind !== 'esperando') return;
    const id = stage.cobro.card?.id ?? stage.cobro.saldo?.chargeId ?? '';
    if (paidOnce.current === id) return;
    paidOnce.current = id;
    // Pagada la cuenta: se vacía (una invitación no la toca).
    if (stage.request.fromCuenta) setCuenta(EMPTY_CUENTA);
    onCobroDone();
  }, [stage, onCobroDone]);

  const backToCarta = useCallback(() => {
    go({ kind: 'carta' });
    setError(null);
    setRetryError(null);
  }, [go]);

  /** Tocar una loseta: «Copa» (y el resto) se suma a la cuenta; «Copa con invitación», a escanear el QR de la chica. */
  function pickItem(item: CartaItem) {
    if (tapOf(item) === 'invitar') {
      setError(null);
      go({ kind: 'escanear', invite: item });
      return;
    }
    setCuenta((c) => addItem(c, item));
  }

  function otroDone(section: CuentaSection, cents: number) {
    const next = addAmount(cuenta, section, cents);
    if (cuenta.length === 0 && section !== PROPINAS) {
      setCuenta(next);
      cobrarCuenta(next);
      return;
    }
    setCuenta(next);
    go({ kind: 'carta' });
  }

  async function cobrarPos() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const totals = cuentaTotals(cuenta);
      const created = await createCobro({
        lines: chargeLinesOf(cuenta),
        pos: true,
        terminalExternalId: terminals[0]?.externalId,
        tipCents: totals.tipCents,
      });
      go({ kind: 'pos', payment: created, label: cuentaWhat(cuenta) });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const miQr = miQrOpen && user.role === 'OPERATOR' ? (
    <MiQr name={name} invitations={night?.invitations ?? null} onClose={() => onMiQr?.(false)} />
  ) : null;
  const headerExtra =
    user.role === 'OPERATOR' && onMiQr ? (
      <button type="button" className={styles.iconBtn} onClick={() => onMiQr(true)} aria-label="Mi QR para las invitaciones">
        <IconQr />
      </button>
    ) : onRecargar ? (
      <button type="button" className={styles.iconBtn} onClick={onRecargar} aria-label="Recargar saldo">
        <IconPlus />
      </button>
    ) : null;
  const menuModal = (
    <Modal open={menu} onClose={() => setMenu(false)} title="Menú">
      <div className={styles.menu}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
          <span>Tema</span>
          <ThemeToggle />
        </div>
        {onRecargar ? (
          <Button
            variant="ghost"
            onClick={() => {
              setMenu(false);
              onRecargar();
            }}
          >
            Recargar saldo
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onLogout}>
          Salir
        </Button>
      </div>
    </Modal>
  );

  switch (stage.kind) {
    case 'esperando':
      return (
        <Esperando
          key={stage.cobro.card?.id ?? stage.cobro.saldo?.chargeId}
          cobro={stage.cobro}
          onNew={backToCarta}
          onRetry={() => void retry()}
          retrying={retrying}
          retryError={retryError}
          onPaid={onPaid}
          sectionLabel={(s) => labelOf(ctx, s)}
        />
      );
    case 'pos':
      return (
        <ActivePayment
          key={stage.payment.id}
          payment={stage.payment}
          isPos
          label={stage.label}
          onPaid={onCobroDone}
          onClose={() => {
            setCuenta(EMPTY_CUENTA);
            backToCarta();
          }}
        />
      );
    case 'otro':
      return (
        <OtroImporte
          ctx={ctx}
          who={who}
          adding={cuenta.length > 0}
          onDone={otroDone}
          onBack={backToCarta}
          busy={busy}
          error={error}
        />
      );
    case 'cuenta':
      return (
        <LaCuenta
          ctx={ctx}
          cuenta={cuenta}
          who={who}
          onQty={(key, qty) => setCuenta((c) => setQty(c, key, qty))}
          onRemove={(key) => setCuenta((c) => removeLine(c, key))}
          onAdd={backToCarta}
          onBack={backToCarta}
          onCobrar={() => cobrarCuenta()}
          onPos={methods.pos ? () => void cobrarPos() : undefined}
          busy={busy}
          error={error}
          nfc={nfc}
        />
      );
    case 'escanear':
      return (
        <div className={styles.overlay}>
          <EscanearChica
            ctx={ctx}
            who={who}
            title={stage.invite.name}
            priceCents={stage.invite.priceCents}
            onChica={(chica) => invitar(stage.invite, chica)}
            onList={
              rules?.requireQr === false
                ? () => {
                    setError(null);
                    go({ kind: 'lista', invite: stage.invite });
                  }
                : undefined
            }
            onBack={backToCarta}
          />
          {busy ? <p className={styles.toast}>Un momento…</p> : null}
          {error ? (
            <p role="alert" className={styles.error} style={{ padding: '0 1rem 1rem' }}>
              {error}
            </p>
          ) : null}
        </div>
      );
    case 'lista':
      return (
        <ElegirChica
          ctx={ctx}
          who={who}
          priceCents={stage.invite.priceCents}
          onPick={(c) => invitar(stage.invite, { name: c.name, id: c.id })}
          onBack={() => {
            setError(null);
            go({ kind: 'escanear', invite: stage.invite });
          }}
          busy={busy}
          error={error}
        />
      );
    case 'carta':
    default:
      return (
        <>
          <Carta
            ctx={ctx}
            cuenta={cuenta}
            who={who}
            onItem={pickItem}
            onTip={(cents) => setCuenta((c) => addAmount(c, PROPINAS, cents))}
            onOtro={() => {
              setError(null);
              go({ kind: 'otro' });
            }}
            onVerCuenta={() => go({ kind: 'cuenta' })}
            onCobrar={() => cobrarCuenta()}
            busy={busy}
            error={error}
            onLogo={() => setMenu(true)}
            headerExtra={headerExtra}
            onRetryCarta={carta.retry}
          />
          {menuModal}
          {miQr}
        </>
      );
  }
}
