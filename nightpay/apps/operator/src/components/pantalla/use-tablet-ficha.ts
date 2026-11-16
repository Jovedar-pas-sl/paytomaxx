import { useCallback, useEffect, useState } from 'react';
import { DisplayApiError, payScreenFicha } from '@/lib/customer-display-api';
import { askNfcPermission, nfcSupported, readCard } from '@/lib/nfc';
import type { WaitingView } from '@/lib/pantalla-state';

/** Un texto corto (ficha vacía, sin PIN…) se va solo. */
const NOTE_MS = 4_000;
/** Tras un error de lectura, se vuelve a escuchar un poco después. */
const RETRY_MS = 1_500;

export const NO_PIN_NOTE = 'Esta ficha no tiene PIN. Paga con el QR o en el móvil del camarero.';
export const PIN_LOCKED_NOTE = 'El PIN de esta ficha está bloqueado por fallos. Avisa al camarero.';
export const EMPTY_FICHA_NOTE = 'Esta ficha está vacía: se carga en recepción.';

/** El PIN que pide la tablet: de qué ficha y para qué cobro (su key). */
export interface TabletPinStep {
  key: string;
  ficha: { card: string; uid: string | null };
  reason: string | null;
}

/**
 * La ficha acercada a la tablet (Android con Chrome: Web NFC). Hace lo mismo
 * que el móvil del camarero: paga el cobro activo sin PIN si se puede; si no,
 * pide el PIN aquí, delante del cliente. Solo escucha con un cobro con ficha
 * esperando (no mientras paga en su banco ni con el PIN delante). Sin NFC en
 * la tablet (`nfcHere` false) no hace nada: la ficha va al móvil del camarero.
 */
export function useTabletFicha(view: WaitingView | null, refresh: () => void) {
  const [supported, setSupported] = useState(false);
  // Sin permiso de Chrome (hace falta un toque la primera vez): se pide desde el menú.
  const [blocked, setBlocked] = useState(false);
  const [pin, setPin] = useState<TabletPinStep | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  useEffect(() => setSupported(nfcSupported()), []);

  const key = view && view.ficha && !view.paying ? view.key : null;
  const listens = supported && !blocked && key !== null && pin === null && !busy;

  useEffect(() => {
    if (!note) return undefined;
    const t = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);

  // Otro cobro (o ya no espera): el PIN de antes ya no vale.
  useEffect(() => {
    if (pin && pin.key !== key) setPin(null);
  }, [pin, key]);

  useEffect(() => {
    if (!listens || !key) return undefined;
    const ctrl = new AbortController();
    const again = (ms = 0) => setTimeout(() => !ctrl.signal.aborted && setRound((n) => n + 1), ms);
    void (async () => {
      let read: Awaited<ReturnType<typeof readCard>>;
      try {
        read = await readCard(ctrl.signal);
      } catch (err) {
        if (ctrl.signal.aborted || (err as Error).name === 'AbortError') return;
        if ((err as Error).name === 'NotAllowedError') {
          setBlocked(true);
          return;
        }
        setNote((err as Error).message);
        again(RETRY_MS);
        return;
      }
      if (ctrl.signal.aborted) return;
      if (!read.token) {
        setNote(EMPTY_FICHA_NOTE);
        again(RETRY_MS);
        return;
      }
      setBusy(true);
      try {
        const out = await payScreenFicha(key, read.token, read.uid);
        if (out.status === 'paid') refresh();
        else if (out.status === 'pin') setPin({ key, ficha: { card: read.token, uid: read.uid }, reason: out.reason });
        else setNote(out.status === 'no_pin' ? NO_PIN_NOTE : PIN_LOCKED_NOTE);
      } catch (err) {
        // Ya pagado, otro cobro, sin saldo suficiente…: el texto del API (nunca el saldo).
        setNote(err instanceof DisplayApiError ? err.message : 'No se ha podido pagar. Vuelve a intentarlo.');
        refresh();
      } finally {
        setBusy(false);
        again(RETRY_MS);
      }
    })();
    return () => ctrl.abort();
  }, [listens, key, round, refresh]);

  /** «Leer fichas en esta tablet»: dentro del toque, Chrome pide el permiso. */
  const enable = useCallback(async () => {
    if (await askNfcPermission()) {
      setBlocked(false);
      setRound((n) => n + 1);
    }
  }, []);

  return {
    /** Esta tablet lee fichas ahora mismo. */
    nfcHere: supported && !blocked,
    /** Lee fichas pero Chrome aún no dio permiso. */
    needsPermission: supported && blocked,
    enable,
    pin,
    closePin: () => setPin(null),
    note,
    setNote,
    busy,
  };
}
