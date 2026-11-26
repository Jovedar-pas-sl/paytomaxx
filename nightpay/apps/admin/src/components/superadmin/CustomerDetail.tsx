'use client';

import { useState } from 'react';
import { Button, Card } from '@nightpay/ui';
import type { CustomerWalletDetail } from '@nightpay/contracts';
import { formatDateTime } from '@/lib/dates';
import {
  blockSaCustomer,
  fetchSaCustomer,
  relinkSaCustomer,
  unblockSaCustomer,
  unlockSaCustomerPin,
} from '@/lib/endpoints/superadmin';
import { formatEur } from '@/lib/money';
import { MOVEMENT_LABELS, formatSignedEur, movementStatusLabel, walletStatus } from '@/lib/superadmin/labels';
import { useVenueTimezone } from '@/lib/venue-context';
import { Notice } from '../Notice';
import { Pill } from '../Pill';
import { QrCode } from './QrCode';
import { ResultDialog, StepUpDialog } from './StepUpDialog';
import { BackButton, LoadGate, MetaList, SecretBox, StickyActions } from './ui';
import { useLoad } from './use-load';

type WalletAction = 'block' | 'unblock' | 'unlockPin' | 'relink';

interface Props {
  walletId: string;
  /** Abrir otro saldo (al que se sumó esta recarga). */
  onOpenWallet: (walletId: string) => void;
  /** Volver a la lista de resultados (si había varios). */
  onBack?: () => void;
}

/** Ficha de un saldo: cuánto tiene, de dónde es, sus llaves y movimientos, y qué se le puede hacer. */
export function CustomerDetailView({ walletId, onOpenWallet, onBack }: Props) {
  const detail = useLoad((signal) => fetchSaCustomer(walletId, signal), [walletId]);
  const tz = useVenueTimezone();
  const [dialog, setDialog] = useState<WalletAction | null>(null);
  const [link, setLink] = useState<{ url: string; removedPasskeys: number } | null>(null);

  return (
    <div className="np-sa-stack">
      {onBack ? <BackButton onClick={onBack}>Resultados</BackButton> : null}
      <LoadGate loaded={detail} what="el saldo">
        {(w) => {
          const status = walletStatus(w.status);
          const label = w.code ?? 'este saldo';
          return (
            <>
              <Card variant="elevated" className="np-sa-card">
                <div className="np-sa-stack-sm">
                  <div className="np-sa-wallet-head">
                    <div>
                      <p className="np-sa-kicker">Saldo {w.label ? `· ${w.label}` : ''}</p>
                      <p className="np-sa-code">{w.code ?? 'Sin código'}</p>
                    </div>
                    <span className="np-sa-btn-row">
                      <Pill tone={status.tone}>{status.label}</Pill>
                      {w.blocked ? <Pill tone="danger">Bloqueado</Pill> : null}
                      {w.closeRequestedAt ? <Pill tone="warning">Devolución pedida antes</Pill> : null}
                    </span>
                  </div>
                  <p className="np-sa-balance np-num">{formatEur(w.balanceCents)}</p>
                  {w.blocked ? (
                    <Notice tone="danger">
                      Bloqueado
                      {w.blockedAt ? ` desde ${formatDateTime(w.blockedAt, tz, 'datetime')}` : ''}
                      {w.blockedReason ? ` por «${w.blockedReason}»` : ''}: no puede pagar (ni Face ID ni PIN). El saldo
                      sigue siendo suyo.
                    </Notice>
                  ) : null}
                  {w.mergedIntoId ? (
                    <Notice tone="info" action={{ label: 'Abrir ese saldo', onClick: () => onOpenWallet(w.mergedIntoId ?? '') }}>
                      Esta recarga se sumó a otro saldo: el del cliente es ese.
                    </Notice>
                  ) : null}
                  <MetaList
                    items={[
                      ['Local de origen', w.homeVenue.name],
                      ['Grupo del saldo', w.walletGroup ?? 'Ninguno'],
                      ['Alta', formatDateTime(w.createdAt, tz, 'datetime')],
                      ['Llaves (Face ID)', w.passkeysCount],
                      ['Fichas NFC', cardsText(w.cards)],
                      ['PIN', pinText(w)],
                    ]}
                  />
                  <StickyActions>
                    {w.blocked ? (
                      <Button type="button" onClick={() => setDialog('unblock')}>
                        Desbloquear
                      </Button>
                    ) : (
                      <Button type="button" variant="danger" onClick={() => setDialog('block')}>
                        Bloquear
                      </Button>
                    )}
                    {w.pin.locked ? (
                      <Button type="button" variant="ghost" onClick={() => setDialog('unlockPin')}>
                        Desbloquear PIN
                      </Button>
                    ) : null}
                    <Button type="button" variant="ghost" onClick={() => setDialog('relink')}>
                      Enlace nuevo
                    </Button>
                  </StickyActions>
                </div>
              </Card>
              <Movements wallet={w} />
              {dialog ? (
                <WalletActionDialog
                  action={dialog}
                  label={label}
                  balance={formatEur(w.balanceCents)}
                  onClose={() => setDialog(null)}
                  onRun={async (reason, totpCode) => {
                    if (dialog === 'relink') {
                      setLink(await relinkSaCustomer(w.walletId, { totpCode, reason }));
                    } else {
                      detail.setData(await runWalletAction(dialog, w.walletId, reason, totpCode));
                    }
                    setDialog(null);
                  }}
                />
              ) : null}
              {link ? (
                <ResultDialog title="Enlace nuevo del saldo" onClose={() => setLink(null)}>
                  <Notice tone="danger">
                    <strong>El primer móvil que active Face ID con él se queda con el saldo.</strong> Vale una sola vez y 10 minutos:
                    dáselo solo al cliente, en persona o a su propio WhatsApp. El enlace de antes ya no vale.
                  </Notice>
                  <div className="np-sa-qr-wrap">
                    <QrCode value={link.url} label={`QR del enlace nuevo del saldo ${label}`} />
                  </div>
                  <SecretBox label="Enlace de activación (un solo uso, 10 min)" value={link.url} />
                  {link.removedPasskeys > 0 ? (
                    <p className="np-sa-help">
                      Se borraron sus llaves de Face ID ({link.removedPasskeys}): las vuelve a activar desde el enlace.
                    </p>
                  ) : null}
                </ResultDialog>
              ) : null}
            </>
          );
        }}
      </LoadGate>
    </div>
  );
}

function cardsText(cards: CustomerWalletDetail['cards']): string {
  const active = `${cards.active} ${cards.active === 1 ? 'activa' : 'activas'}`;
  if (!cards.blocked) return active;
  return `${active} · ${cards.blocked} ${cards.blocked === 1 ? 'bloqueada' : 'bloqueadas'}`;
}

function pinText(w: CustomerWalletDetail): string {
  if (!w.pin.hasPin) return 'Sin PIN';
  if (w.pin.locked) return `Bloqueado (${w.pin.fails} fallos)`;
  return w.pin.fails > 0 ? `Puesto · ${w.pin.fails} fallos` : 'Puesto';
}

async function runWalletAction(
  action: Exclude<WalletAction, 'relink'>,
  walletId: string,
  reason: string,
  totpCode: string,
): Promise<CustomerWalletDetail> {
  switch (action) {
    case 'block':
      return blockSaCustomer(walletId, reason);
    case 'unblock':
      return unblockSaCustomer(walletId, { totpCode, reason });
    case 'unlockPin':
      return unlockSaCustomerPin(walletId, { totpCode, reason });
  }
}

const WALLET_DIALOGS: Readonly<
  Record<WalletAction, { title: string; submit: string; danger?: boolean; summary: (label: string, balance: string) => string }>
> = {
  block: {
    title: 'Bloquear el saldo',
    submit: 'Bloquear',
    danger: true,
    summary: (l, b) => `Vas a bloquear ${l} (${b}): no podrá pagar con Face ID ni con PIN. Se le puede seguir devolviendo.`,
  },
  unblock: {
    title: 'Desbloquear el saldo',
    submit: 'Desbloquear',
    summary: (l, b) => `Vas a desbloquear ${l} (${b}): podrá volver a pagar.`,
  },
  unlockPin: {
    title: 'Desbloquear el PIN',
    submit: 'Desbloquear PIN',
    summary: (l) => `Vas a dejar que ${l} pruebe otra vez su PIN (estaba bloqueado tras 5 fallos).`,
  },
  relink: {
    title: 'Enlace nuevo del saldo',
    submit: 'Crear enlace nuevo',
    danger: true,
    summary: (l, b) =>
      `Vas a crear un enlace nuevo para ${l} (${b}). El de antes deja de valer y se borran sus llaves de Face ID.`,
  },
};

function WalletActionDialog({
  action,
  label,
  balance,
  onRun,
  onClose,
}: {
  action: WalletAction;
  label: string;
  balance: string;
  onRun: (reason: string, totpCode: string) => Promise<void>;
  onClose: () => void;
}) {
  const spec = WALLET_DIALOGS[action];
  const saAction = action === 'block' ? 'wallet.block' : action === 'unblock' ? 'wallet.unblock' : action === 'unlockPin' ? 'wallet.unlockPin' : 'wallet.relink';
  return (
    <StepUpDialog
      title={spec.title}
      action={saAction}
      summary={spec.summary(label, balance)}
      intro={
        action === 'relink' ? (
          <p className="np-sa-text">
            Para el cliente que perdió el móvil o su página del saldo. Sale un QR de activación de un solo uso (10
            minutos): con él activa Face ID en su móvil y su móvil sigue a su saldo. Se lo darás tú.
          </p>
        ) : undefined
      }
      reasonPlaceholder={action === 'block' ? 'Por ejemplo: el cliente dice que le robaron el móvil' : 'Por ejemplo: cliente identificado en barra'}
      submitLabel={spec.submit}
      danger={spec.danger}
      onSubmit={({ reason, totpCode }) => onRun(reason, totpCode)}
      onClose={onClose}
    />
  );
}

function Movements({ wallet }: { wallet: CustomerWalletDetail }) {
  const tz = useVenueTimezone();
  if (wallet.movements.length === 0) return <p className="np-sa-empty">Sin movimientos.</p>;
  return (
    <section className="np-sa-stack-sm" aria-label="Movimientos">
      <h3 className="np-sa-subtitle">Últimos movimientos</h3>
      <Card className="np-table-host" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="np-sa-scroll-x">
          <table className="np-table">
            <thead>
              <tr>
                <th>Cuándo</th>
                <th>Qué</th>
                <th>Local</th>
                <th>Estado</th>
                <th style={{ textAlign: 'right' }}>Importe</th>
              </tr>
            </thead>
            <tbody>
              {wallet.movements.map((m) => (
                <tr key={`${m.kind}-${m.id}`}>
                  <td data-label="Cuándo" data-card="top">
                    {formatDateTime(m.at, tz, 'short')}
                  </td>
                  <td data-label="Qué" data-card="title">
                    {MOVEMENT_LABELS[m.kind]}
                    {m.label && m.label !== MOVEMENT_LABELS[m.kind] ? <span className="np-sa-dim"> · {m.label}</span> : null}
                  </td>
                  <td data-label="Local">{m.venue.name}</td>
                  <td data-label="Estado">{movementStatusLabel(m.status)}</td>
                  <td
                    data-label="Importe"
                    data-card="amount"
                    className="np-num np-sa-amount"
                    data-sign={m.amountCents >= 0 ? 'in' : 'out'}
                  >
                    {formatSignedEur(m.amountCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}
