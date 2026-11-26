'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { haptic, Icon, Modal } from '@nightpay/ui';
import type { InvitationRules } from '@nightpay/contracts';
import { fetchTerminals, newIdempotencyKey, type CreatedPayment, type MyNight, type OperatorUser } from '@/lib/api';
import { cancelCard, cancelSaldo, createCobro, createSaldoCobro, fetchCardGateways, fetchInvitationRules, type CardGateway, type CobroInput } from '@/lib/api-cobro';
import { tapOf } from '@/lib/carta-tiles';
import {
  addedItemLabel,
  addedItemSpoken,
  itemTileKey,
  pickable,
  undoTap,
  UNDO_MS,
  type UndoTap,
} from '@/lib/carta-view';
import { arrivedTooLate, cancelTargetOf } from '@/lib/cobro-attempt';
import { invitationSplit, splitCells, whoLine } from '@/lib/cobro-view';
import {
  EMPTY_CUENTA,
  addItem,
  chargeLinesOf,
  cobrarYApuntar,
  cuentaTotals,
  cuentaWhat,
  otroPlan,
  qtyOf,
  removeLine,
  setQty,
  ticketLinesOf,
  type CartaItem,
  type Cuenta,
  type CuentaSection,
} from '@/lib/cuenta';
import { useMySections } from '@/lib/sections';
import { useVenueMethods, useVenueNight } from '@/lib/venue-methods';
import { nfcSupported } from '@/lib/nfc';
import { isParty } from '@/lib/edition';
import { partySections, stepLine, ticketSummary } from '@/lib/party-barra';
import { PracticeBlockedError, isPractice } from '@/lib/practice';
import { setPracticeNextAmount } from '@/lib/practice-sim';
import { placeName, useVenueIdentity } from '@/lib/venue-identity';
import { SERVICIO_SCAN_TEXTS, needsCompanera, servicioDe } from '@/lib/servicio';
import { ActivePayment } from '../ActivePayment';
import { useCarta } from '../carta';
import { Barra } from '../party/Barra';
import { Carta } from './Carta';
import { cobraElEncargado, customerTipsOn, labelOf, servedTipsOn, type CobrarContext } from './cobrar-context';
import { ElegirChica } from './ElegirChica';
import { EscanearChica, type Invitada } from './EscanearChica';
import { Esperando, type CobroAbierto } from './Esperando';
import { LaCuenta } from './LaCuenta';
import { MiQr } from './MiQr';
import { OtroImporte } from './OtroImporte';
import { ServicioDe } from './ServicioDe';
import { SinCobrar } from './SinCobrar';
import { GuiaMenuLink, InstallMenuItem, LogoutMenuItem, MENU_HINTS, MenuOption, PracticeMenuItem, useDeviceMenu } from '../staff-menu';
import { CustomerDisplaySheet } from '../CustomerDisplaySheet';
import { ProfileSheet } from '../ProfileSheet';
import styles from './cobrar.module.css';

type Stage =
  | { kind: 'carta' }
  | { kind: 'otro' }
  | { kind: 'cuenta' }
  | { kind: 'escanear'; invite: CartaItem }
  | { kind: 'lista'; invite: CartaItem }
  // Cobro por el encargado: el API pide la compañera del servicio; se escanea su «Mi QR» y se cobra esa cuenta.
  | { kind: 'companera'; cuenta: Cuenta; skipRaw?: string }
  | { kind: 'servicioDe'; cuenta: Cuenta; chica: Invitada }
  | { kind: 'esperando'; cobro: CobroAbierto; request: Pending }
  | { kind: 'pos'; payment: CreatedPayment; label: string };

/** Lo que se pidió (para «Otro QR · mismo importe») y si era la cuenta (se vacía al pagarse). */
interface Pending {
  input: Omit<CobroInput, 'idempotencyKey'>;
  fromCuenta: boolean;
  /** La cuenta que se cobra (solo los cobros de la cuenta): si el API pide la compañera, se escanea con ella. */
  cuenta?: Cuenta;
  view: Omit<CobroAbierto, 'card' | 'saldo' | 'saldoQr' | 'saldoUrl' | 'ref'>;
}

interface Props {
  user: OperatorUser;
  /** Pagado o vuelta a la carta: refrescar lo de la chica. */
  onCobroDone: () => void;
  onLogout: () => void;
  /** La noche de la compañera (sus invitaciones, en «Mi QR»; lo que lleva, en «Hoy cobra el encargado»). */
  night?: MyNight | null;
  /** Abrir «Mi QR» desde fuera (la chica). */
  miQrOpen?: boolean;
  onMiQr?: (open: boolean) => void;
  /** «Recargar saldo» (maquetas 4.6–4.7): solo quien carga saldos (recepción, encargado, dueño). */
  onRecargar?: () => void;
  /** Encima de la carta (el RRPP: «Tus reservas de RRPP»). */
  banner?: ReactNode;
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
export function CobrarFlow({ user, onCobroDone, onLogout, night, miQrOpen = false, onMiQr, onRecargar, banner }: Props) {
  const mine = useMySections();
  const methods = useVenueMethods();
  const nightSettings = useVenueNight();
  const carta = useCarta();
  // OxioParty: la barra de la caseta (sin chicas, habitaciones ni servicios).
  const party = isParty();
  const identity = useVenueIdentity();
  const [rules, setRules] = useState<InvitationRules | null>(null);
  const [terminals, setTerminals] = useState<Array<{ externalId: string }>>([]);
  // Local con BBVA y Yavin: los dos botones para elegir en cada cobro con tarjeta (vacío: sin elección).
  const [gateways, setGateways] = useState<CardGateway[]>([]);
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
  // «Mi perfil» también desde el menú de Cobrar (la pantalla principal del personal).
  const [profile, setProfile] = useState(false);
  // «Pantalla del cliente» (Menú): la tablet de la barra.
  const [display, setDisplay] = useState(false);
  const device = useDeviceMenu(() => setMenu(false));
  const attempt = useRef<{ key: string; what: string } | null>(null);
  /** Lo último que se tocó en la carta: el pie ofrece «Deshacer» durante 4 s (decisión D3). */
  const [undo, setUndo] = useState<UndoTap | null>(null);
  const undoSeq = useRef(0);

  useEffect(() => {
    if (!undo) return undefined;
    const timer = setTimeout(() => setUndo((u) => (u?.id === undo.id ? null : u)), UNDO_MS);
    return () => clearTimeout(timer);
  }, [undo]);

  useEffect(() => {
    let cancelled = false;
    fetchInvitationRules()
      .then((r) => !cancelled && setRules(r))
      .catch(() => undefined);
    fetchTerminals()
      .then((t) => !cancelled && setTerminals(t))
      .catch(() => undefined);
    void fetchCardGateways().then((g) => !cancelled && setGateways(g));
    return () => {
      cancelled = true;
    };
  }, []);

  const ctx: CobrarContext = useMemo(
    () => ({
      user,
      sections: party ? partySections(mine.sections) : mine.sections,
      allowed: mine.allowed,
      post: mine.post ?? null,
      defaultCategory: mine.defaultCategory,
      tips: mine.tips !== false,
      fromPhone: mine.fromPhone ?? null,
      serviceTips: mine.serviceTips ?? null,
      methods,
      night: nightSettings,
      rules,
      carta: carta.services,
      cartaLoaded: carta.loaded,
      cartaFailed: carta.failed,
    }),
    [user, mine, party, methods, nightSettings, rules, carta.services, carta.loaded, carta.failed],
  );
  const who = whoLine(user.displayName, user.role);
  const name = user.displayName?.trim() || who;
  const nfc = methods.wallet && methods.nfc && nfcSupported();
  // Los dos botones «BBVA» y «Yavin» solo con tarjeta y las dos pasarelas en el local.
  const choose = methods.card && gateways.length === 2 ? gateways : null;

  /** Crea el cobro (único: tarjeta + saldo; o solo saldo si el local no cobra con tarjeta). */
  const open = useCallback(
    async (pending: Pending, key: string): Promise<CobroAbierto> => {
      const totals = pending.view.totalCents;
      // En práctica, el simulador no ve precios en las líneas de la carta: se le dice el importe.
      if (isPractice()) setPracticeNextAmount(totals);
      if (methods.card) {
        // La lista se pide al entrar y puede haber fallado (mala cobertura): sin ella no se cobra, así que otra vez.
        const terminal = terminals[0]?.externalId ?? (await fetchTerminals().then((t) => (setTerminals(t), t[0]?.externalId), () => undefined));
        const created = await createCobro({ ...pending.input, terminalExternalId: terminal, idempotencyKey: key });
        return { ...pending.view, totalCents: totals, card: created, saldo: created.saldo ?? null, ref: created.ref ?? null };
      }
      if (methods.wallet) {
        const s = await createSaldoCobro(pending.input);
        return {
          ...pending.view,
          card: null,
          saldo: { chargeId: s.id, expiresAt: s.expiresAt },
          saldoQr: s.qrPngDataUrl,
          saldoUrl: s.payUrl,
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
    // Fuera de la carta ya no hay «Deshacer» (la cuenta se corrige en «La cuenta»).
    setUndo(null);
    // Pantalla nueva, desde arriba (la carta puede venir con el scroll abajo, hasta «Otro importe»).
    window.scrollTo({ top: 0 });
    setStage(next);
  }, []);

  /** Un toque en la carta: la cuenta nueva y, durante 4 s, cómo estaba antes. */
  function tapped(next: Cuenta, tap: Pick<UndoTap, 'label' | 'spoken' | 'tile'>) {
    undoSeq.current += 1;
    setUndo({ id: undoSeq.current, ...tap, before: cuenta });
    setCuenta(next);
  }

  function undoLast() {
    setCuenta((c) => undoTap(undo, c));
    setUndo(null);
  }

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
      haptic();
      const cobro = await open(pending, attempt.current.key);
      attempt.current = null;
      if (arrivedTooLate(asked, screen.current)) {
        await dropCobro(cobro);
        return false;
      }
      go({ kind: 'esperando', cobro, request: pending });
      return true;
    } catch (err) {
      if (arrivedTooLate(asked, screen.current)) return false;
      // Con la casilla apagada, el API pide la compañera del servicio: a escanear su «Mi QR», con la misma cuenta.
      if (needsCompanera(err) && pending.cuenta) go({ kind: 'companera', cuenta: pending.cuenta });
      else setError((err as Error).message);
      return false;
    } finally {
      busyNow.current = false;
      setBusy(false);
    }
  }

  /** La cuenta → el cobro (true si se abrió). Con `chica`, a su nombre: Servicios va para ella. */
  function cobrarCuenta(c: Cuenta = cuenta, chica?: Invitada, gateway?: CardGateway): Promise<boolean> {
    const totals = cuentaTotals(c);
    const sections = totals.bySection;
    const what = cuentaWhat(c);
    const top = [...sections].sort((a, b) => b.cents - a.cents)[0]?.section ?? 'VENUE_BAR';
    return start({
      // B1: sin propina al crear; la elige el cliente al pagar.
      input: { lines: chargeLinesOf(c), ...(chica ? { serviceStaffToken: chica.token } : {}), ...(gateway ? { cardGateway: gateway } : {}) },
      fromCuenta: true,
      cuenta: c,
      view: {
        totalCents: totals.totalCents,
        tipsOn: chica ? servedTipsOn(ctx) : customerTipsOn(ctx),
        sections,
        // El título de Esperando, sin mayúsculas (Grafito): «Copas + Comida».
        // OxioParty: la caseta y lo que se cobra («2 × caña · 1 × tinto de verano»).
        band: party
          ? { title: placeName(identity, 'Barra'), detail: ticketSummary(c) }
          : chica
            ? { title: `Servicio de ${chica.name}`, detail: `${what} · ${name}` }
            : {
                title: sections
                  .slice(0, 2)
                  .map((s) => labelOf(ctx, s.section))
                  .join(' + '),
                detail: `${what} · ${name}`,
              },
        what,
        lines: ticketLinesOf(c),
        who: name,
        pinChip: chica ? `${labelOf(ctx, 'CHICA_SERVICE')} · ${chica.name}` : `${labelOf(ctx, top)} · ${name}`,
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
        tipsOn: customerTipsOn(ctx),
        sections: [{ section: invite.category, cents: invite.priceCents }],
        band: { title: 'Invitación', detail: `${chica.name} · ${name}` },
        what: 'Invitación',
        lines: [{ label: invite.name, qty: 1, unitCents: invite.priceCents, amountCents: invite.priceCents }],
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
      // Su «Mi QR» caducó (dura 10 min) o la casilla se apagó: a escanearlo otra vez, con la misma cuenta.
      if (needsCompanera(err) && stage.request.cuenta) go({ kind: 'companera', cuenta: stage.request.cuenta });
      else setRetryError((err as Error).message);
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
    if (!pickable(item)) return;
    if (tapOf(item) === 'invitar') {
      setError(null);
      go({ kind: 'escanear', invite: item });
      return;
    }
    haptic();
    const next = addItem(cuenta, item);
    tapped(next, {
      label: addedItemLabel(item.name),
      spoken: addedItemSpoken(item.name, qtyOf(next, item.id)),
      tile: itemTileKey(item.id),
    });
  }

  function otroDone(section: CuentaSection, cents: number) {
    const plan = otroPlan(cuenta, section, cents);
    if (plan.kind === 'cobrar') {
      // A la cuenta solo si el cobro se abre: tras un fallo, el segundo toque cobra lo mismo (no el doble).
      void cobrarYApuntar(plan.next, cobrarCuenta, setCuenta);
      return;
    }
    setCuenta(plan.next);
    go({ kind: 'carta' });
  }

  /** Con datáfono, la cuenta que recibe (la de «Otro importe» aún no está apuntada); con `chica`, a su nombre. */
  async function cobrarPos(c: Cuenta = cuenta, chica?: Invitada) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createCobro({
        lines: chargeLinesOf(c),
        pos: true,
        terminalExternalId: terminals[0]?.externalId,
        ...(chica ? { serviceStaffToken: chica.token } : {}),
      });
      go({ kind: 'pos', payment: created, label: cuentaWhat(c) });
    } catch (err) {
      if (needsCompanera(err)) go({ kind: 'companera', cuenta: c });
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // La compañera con la casilla del local apagada: «Hoy cobra el encargado» en lugar de la carta.
  const sinCarta = cobraElEncargado(ctx);
  const miQr = miQrOpen && user.role === 'OPERATOR' ? (
    <MiQr name={name} invitations={night?.invitations ?? null} forService={sinCarta} onClose={() => onMiQr?.(false)} />
  ) : null;
  const headerExtra =
    user.role === 'OPERATOR' && onMiQr ? (
      <button type="button" className={styles.iconBtn} onClick={() => onMiQr(true)} aria-label="Mi QR para las invitaciones" data-tour="cobrar-miqr">
        <Icon name="qr" />
      </button>
    ) : onRecargar ? (
      <button type="button" className={styles.iconBtn} onClick={onRecargar} aria-label="Recargar saldo" data-tour="cobrar-recargar">
        <Icon name="plus" />
      </button>
    ) : null;
  const menuModal = (
    <>
    <ProfileSheet open={profile} onClose={() => setProfile(false)} onLogout={onLogout} />
    <CustomerDisplaySheet open={display} onClose={() => setDisplay(false)} />
    {device.sheet}
    <Modal open={menu} onClose={() => setMenu(false)} title="Menú">
      {/* El tema se elige en «Mi perfil» (por defecto, oscuro). */}
      <div className={styles.menu}>
        <MenuOption
          title="Mi perfil"
          hint={MENU_HINTS.profile}
          onClick={() => {
            setMenu(false);
            setProfile(true);
          }}
        />
        {onRecargar ? (
          <MenuOption
            title="Recargar saldo"
            hint={MENU_HINTS.topUp}
            onClick={() => {
              setMenu(false);
              onRecargar();
            }}
          />
        ) : null}
        {/* «Hoy cobra el encargado»: ella no cobra, así que no empareja la pantalla del cliente. */}
        {sinCarta ? null : (
          <MenuOption
            title="Pantalla del cliente"
            hint={MENU_HINTS.display}
            onClick={() => {
              setMenu(false);
              setDisplay(true);
            }}
          />
        )}
        {device.item}
        {/* «Hoy cobra el encargado»: no hay nada que ensayar (salir de práctica, sí). */}
        <PracticeMenuItem onClose={() => setMenu(false)} canStart={!sinCarta} />
        <InstallMenuItem />
        <GuiaMenuLink />
        <LogoutMenuItem onLogout={onLogout} />
      </div>
    </Modal>
    </>
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
          byStaff={user.role !== 'OPERATOR'}
          label={stage.label}
          onPaid={onCobroDone}
          onClose={() => {
            setCuenta(EMPTY_CUENTA);
            backToCarta();
          }}
        />
      );
    case 'companera':
      return (
        <div className={styles.overlay}>
          <EscanearChica
            ctx={ctx}
            who={who}
            title="Servicio"
            priceCents={servicioDe(stage.cuenta).totalCents}
            texts={SERVICIO_SCAN_TEXTS}
            skipRaw={stage.skipRaw}
            onChica={(chica) => {
              go({ kind: 'servicioDe', cuenta: stage.cuenta, chica });
              return Promise.resolve(true);
            }}
            onBack={backToCarta}
          />
        </div>
      );
    case 'servicioDe':
      return (
        <ServicioDe
          ctx={ctx}
          who={who}
          cuenta={stage.cuenta}
          chica={stage.chica}
          onQr={() => void cobrarYApuntar(stage.cuenta, (c) => cobrarCuenta(c, stage.chica), setCuenta)}
          gateways={choose}
          onGateway={(g) => void cobrarYApuntar(stage.cuenta, (c) => cobrarCuenta(c, stage.chica, g), setCuenta)}
          onPos={methods.pos ? () => void cobrarPos(stage.cuenta, stage.chica) : undefined}
          onOtra={() => {
            setError(null);
            go({ kind: 'companera', cuenta: stage.cuenta, skipRaw: stage.chica.raw });
          }}
          onBack={backToCarta}
          busy={busy}
          error={error}
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
          onCobrar={() => void cobrarCuenta()}
          gateways={choose}
          onGateway={(g) => void cobrarCuenta(cuenta, undefined, g)}
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
      return party ? (
        <>
          <Barra
            ctx={ctx}
            cuenta={cuenta}
            onItem={pickItem}
            onStep={(key, delta) => setCuenta((c) => stepLine(c, key, delta))}
            onVaciar={() => setCuenta(EMPTY_CUENTA)}
            onOtro={() => {
              setError(null);
              go({ kind: 'otro' });
            }}
            onCobrar={() => void cobrarCuenta()}
            busy={busy}
            error={error}
            onMenu={() => setMenu(true)}
            onRetryCarta={carta.retry}
          />
          {menuModal}
        </>
      ) : sinCarta ? (
        <>
          <SinCobrar who={who} night={night ?? null} banner={banner} onLogo={() => setMenu(true)} onMiQr={() => onMiQr?.(true)} />
          {menuModal}
          {miQr}
        </>
      ) : (
        <>
          <Carta
            ctx={ctx}
            cuenta={cuenta}
            who={who}
            onItem={pickItem}
            onSoldOut={(item, soldOut) => {
              setError(null);
              haptic();
              carta.setSoldOut(item.id, soldOut).catch((err: unknown) => setError(err instanceof PracticeBlockedError ? err.message : 'No se pudo marcar el producto. Prueba otra vez.'));
            }}
            onOtro={() => {
              setError(null);
              go({ kind: 'otro' });
            }}
            onVerCuenta={() => go({ kind: 'cuenta' })}
            // Con BBVA y Yavin, a «La cuenta», donde se elige con cuál.
            onCobrar={() => (choose ? go({ kind: 'cuenta' }) : void cobrarCuenta())}
            undo={undo}
            onUndo={undoLast}
            busy={busy}
            error={error}
            onLogo={() => setMenu(true)}
            headerExtra={headerExtra}
            onRetryCarta={carta.retry}
            banner={banner}
          />
          {menuModal}
          {miQr}
        </>
      );
  }
}
