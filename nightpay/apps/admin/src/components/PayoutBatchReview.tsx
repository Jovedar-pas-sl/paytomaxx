'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Banner, Button, Checkbox, FormError, Icon, Importe, Sheet } from '@nightpay/ui';
import { stepUpActions, type PayoutBatchItemResult, type PayoutBatchProblem, type PayoutBatchResult, type StepUpMethod, type StepUpProof } from '@nightpay/contracts';
import { createPayoutBatch, type PayoutMethod } from '@/lib/api';
import { newKey } from '@/lib/payout-attempt';
import {
  REVIEW_EXPLAIN,
  batchFailure,
  methodWord,
  notesAfter,
  problemText,
  resultMark,
  resultTitle,
  reviewTexts,
} from '@/lib/payout-batch';
import { proofFor } from '@/lib/refund-confirm';
import { useLockActive } from '@/lib/use-lock';
import { useVenueTimezone } from '@/lib/venue-context';
import { KeyConfirm } from './KeyConfirm';
import { OtpInput } from './OtpInput';

/** Una persona marcada, tal como se vio en la lista. */
export interface BatchItem {
  operatorId: string;
  name: string;
  method: PayoutMethod;
  accountMasked: string;
  /** Lo que se le paga (la cifra vista): va como expectedTotalCents. */
  cents: number;
  /** El titular no se parece a su nombre (se marca igual). */
  holderWarning?: string;
  /** Lo retenido por el banco, que no entra (payoutHoldNote). */
  bankHeldNote?: string;
}

/** Al acabar: lo que se desmarca con su texto, o un aviso para la lista. Siempre recarga. */
export interface BatchAfter {
  notes?: PayoutBatchProblem[];
  notice?: string;
}

interface Props {
  open: boolean;
  items: readonly BatchItem[];
  /** useStepUpMethod de quien paga: 'totp' o sin saber, el código; 'passkey', la llave. */
  method: StepUpMethod | null | undefined;
  /** «Volver» sin haber enviado (o la clave ya no sirve). */
  onClose: () => void;
  onDone: (after: BatchAfter) => void;
}

/**
 * El repaso de «Pagar a varias»: a quién, por dónde, cuánto y el total, la
 * casilla «Ya he pagado…» y UN segundo factor para todos. Envía la foto de
 * personas y cifras de cuando se abrió; la clave nace al abrirlo, sirve para
 * probar otro código aquí y muere con una respuesta 200 o 409, sin respuesta
 * o al cerrarlo (cada apertura es un montaje nuevo).
 */
export function PayoutBatchReview(props: Props) {
  // Solo `open`: abierto, trabaja con su foto aunque la lista viva se quede sin marcadas.
  if (!props.open) return null;
  return <Review {...props} />;
}

type Ended =
  | { kind: 'result'; result: PayoutBatchResult }
  | { kind: 'changed'; text: string; problems: PayoutBatchProblem[] }
  | { kind: 'unknown'; text: string }
  | { kind: 'dead'; text: string };

function Review({ items, method, onClose, onDone }: Props) {
  const tz = useVenueTimezone();
  // La foto de cuando se abrió y su clave: no cambian aunque la lista se mueva.
  const [snap] = useState(() => items.slice());
  const [key] = useState(() => newKey());
  const [confirmed, setConfirmed] = useState(false);
  const [code, setCode] = useState('');
  const [proof, setProof] = useState<StepUpProof | null>(null);
  const [askedForKey, setAskedForKey] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const locked = useLockActive(lockedUntil);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [ended, setEnded] = useState<Ended | null>(null);
  // Un toque = una llamada: el ref para antes de que React pinte «enviando».
  const busy = useRef(false);
  const confirmRef = useRef<HTMLDivElement>(null);

  const n = snap.length;
  const total = snap.reduce((sum, i) => sum + i.cents, 0);
  const texts = reviewTexts(n);
  const withKey = method === 'passkey' || askedForKey;
  const action = stepUpActions.payoutBatch(key, n, total);
  const keyProof = withKey ? proofFor(proof, action, Date.now()) : null;
  const canSend = confirmed && !ended && !sending && (withKey ? Boolean(keyProof) : /^\d{6}$/.test(code) && !locked);

  // Foco en la casilla al abrir (la hoja pone antes el suyo en la ventana).
  useEffect(() => {
    confirmRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, []);

  async function send(): Promise<void> {
    if (busy.current || ended || !confirmed) return;
    if (withKey && !keyProof) return setError('Confírmalo antes con tu llave de acceso.');
    if (!withKey && !/^\d{6}$/.test(code)) return setError('Pon los 6 números de tu app de verificación.');
    if (!withKey && locked) return;
    busy.current = true;
    setSending(true);
    setError(null);
    const usedProof = withKey ? keyProof : null;
    try {
      const result = await createPayoutBatch(
        snap.map((i) => ({ operatorId: i.operatorId, expectedTotalCents: i.cents })),
        {
          idempotencyKey: key,
          ...(usedProof ? { stepUpToken: usedProof.token } : { totpCode: code }),
        },
      );
      setEnded({ kind: 'result', result });
    } catch (err) {
      const f = batchFailure(err, Date.now());
      switch (f.kind) {
        case 'changed':
          setEnded({ kind: 'changed', text: f.text, problems: f.problems });
          break;
        case 'unknown':
          setEnded({ kind: 'unknown', text: f.text });
          break;
        case 'dead':
          setEnded({ kind: 'dead', text: f.text });
          break;
        case 'close':
          onDone({ notice: f.text });
          break;
        case 'locked':
          setLockedUntil(f.until);
          setCode('');
          break;
        case 'passkey':
          setAskedForKey(true);
          setError(f.text);
          break;
        case 'retry':
          if (f.clearCode) setCode('');
          setError(f.text);
          break;
      }
    } finally {
      // La prueba de la llave vale una vez: usada (bien o mal), otra para repetir.
      if (usedProof) setProof(null);
      busy.current = false;
      setSending(false);
    }
  }

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    void send();
  }

  // Enviando no se cierra; con un final, cerrar es volver a la lista (y recargarla).
  const closeGuarded = sending ? () => undefined : ended ? () => onDone(afterOf(ended)) : onClose;

  if (ended?.kind === 'result') {
    const { result } = ended;
    return (
      <Sheet open onClose={closeGuarded} title={resultTitle(result)} full width="32rem" footer={<Button size="lg" onClick={closeGuarded}>Entendido</Button>}>
        <ul className="np-lote-review-list" role="status">
          {result.results.map((r) => (
            <ResultRow key={r.operatorId} r={r} item={snap.find((i) => i.operatorId === r.operatorId)} tz={tz} />
          ))}
        </ul>
      </Sheet>
    );
  }

  const problems = ended?.kind === 'changed' ? new Map(ended.problems.map((p) => [p.operatorId, p])) : null;
  const footer = ended ? (
    <Button size="lg" onClick={closeGuarded}>
      {ended.kind === 'unknown' ? 'Volver a cargar la lista' : 'Volver a la lista'}
    </Button>
  ) : (
    <>
      <Button variant="ghost" size="lg" onClick={onClose} disabled={sending}>
        Volver
      </Button>
      <Button size="lg" onClick={() => void send()} disabled={!canSend && !sending} loading={sending} loadingLabel={texts.sending}>
        {texts.submit}
      </Button>
    </>
  );

  return (
    <Sheet open onClose={closeGuarded} title={texts.title} full width="32rem" footer={footer}>
      <form onSubmit={onSubmit} className="np-lote-review">
        <ul className="np-lote-review-list">
          {snap.map((i) => {
            const p = problems?.get(i.operatorId);
            return (
              <li key={i.operatorId} className="np-lote-review-row">
                <div className="np-lote-review-main">
                  <span className="np-lote-name">{i.name}</span>
                  <span className="np-lote-hint">
                    {methodWord(i.method)} · {i.accountMasked}
                  </span>
                  {i.holderWarning ? (
                    <span className="np-lote-note" data-tone="warning">
                      {i.holderWarning}
                    </span>
                  ) : null}
                  {i.bankHeldNote ? <span className="np-lote-note">{i.bankHeldNote}</span> : null}
                  {p ? (
                    <span className="np-lote-note" data-tone="danger">
                      {problemText(p, { tz, expectedCents: i.cents })}
                    </span>
                  ) : null}
                </div>
                <Importe cents={i.cents} size="row" decimals="always" className="np-lote-amount" />
              </li>
            );
          })}
        </ul>
        <p className="np-lote-total">
          <span>Total</span>
          <Importe cents={total} size="row" decimals="always" />
        </p>

        {ended ? (
          ended.kind === 'unknown' ? (
            <Banner tone="warning">{ended.text}</Banner>
          ) : (
            <FormError>{ended.text}</FormError>
          )
        ) : (
          <>
            <p className="np-lote-explain">{REVIEW_EXPLAIN}</p>
            <div ref={confirmRef}>
              <Checkbox label={texts.confirm} checked={confirmed} onChange={setConfirmed} disabled={sending} />
            </div>
            {withKey ? (
              <KeyConfirm action={action} confirmed={Boolean(keyProof)} onProof={setProof} reason={texts.reason} next={texts.next} />
            ) : (
              <OtpInput
                label="Código de tu app de verificación"
                value={code}
                onChange={setCode}
                autoSubmit={confirmed && !sending}
                lockedUntil={lockedUntil}
                disabled={sending}
                required
              />
            )}
            {error ? <FormError>{error}</FormError> : null}
          </>
        )}
      </form>
    </Sheet>
  );
}

function afterOf(ended: Ended): BatchAfter {
  if (ended.kind === 'result') return { notes: notesAfter(ended.result.results) };
  if (ended.kind === 'changed') return { notes: ended.problems };
  return { notes: [] };
}

function ResultRow({ r, item, tz }: { r: PayoutBatchItemResult; item: BatchItem | undefined; tz: string }) {
  const mark = resultMark(r);
  const note = notesAfter([r])[0];
  return (
    <li className="np-lote-review-row" data-mark={mark}>
      <span className="np-lote-mark" aria-hidden="true">
        <Icon name={mark} size={20} />
      </span>
      <div className="np-lote-review-main">
        <span className="np-lote-name">{item?.name ?? ''}</span>
        {note ? <span className="np-lote-note">{problemText(note, { tz, expectedCents: item?.cents })}</span> : null}
      </div>
      {r.status === 'PAID' ? <Importe cents={r.totalCents ?? item?.cents ?? 0} size="row" decimals="always" className="np-lote-amount" /> : null}
    </li>
  );
}
