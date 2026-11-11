'use client';

import { useEffect, useState } from 'react';
import { Card, Input, Select } from '@nightpay/ui';
import type { PayoutAccountFull, PayoutAccountListItem } from '@nightpay/contracts';
import { maskPayoutTarget } from '@/lib/confirm-summary';
import { formatDateTime } from '@/lib/dates';
import { fetchSaPayoutAccounts, revealSaPayoutAccount, updateSaPayoutAccount } from '@/lib/endpoints/superadmin';
import { FILTER_FIELD, FILTER_SELECT } from '@/lib/filter-field';
import type { PayoutValue } from '@/lib/payout-address';
import { personName } from '@/lib/superadmin/labels';
import { REVEAL_SECONDS, payoutUpdatePayload, revealSecondsLeft } from '@/lib/superadmin/person-forms';
import { EMPTY_PAYOUT_FILTERS, payoutAccountsQuery, type PayoutAccountFilters } from '@/lib/superadmin/query';
import { useVenueTimezone } from '@/lib/venue-context';
import { PAYOUT_METHOD_SHORT, PayoutMethodForm, PayoutMethodOptions } from '../PayoutMethodForm';
import { useSa } from './context';
import { StepUpDialog } from './StepUpDialog';
import { CheckRow, CopyButton, LoadGate, SectionHead, SmallButton } from './ui';
import { useDebounced, useLoad } from './use-load';

interface Revealed {
  userId: string;
  account: PayoutAccountFull;
  /** Se vuelve a tapar en este instante (epoch ms). */
  until: number;
}

/**
 * Cuentas de cobro de las chicas de todos los locales, tapadas. «Ver
 * completa» (2FA) la enseña 30 s; «Cambiar» (2FA y motivo) la comprueba
 * según el método, como la app de las chicas.
 */
export function PayoutAccountsSection() {
  const sa = useSa();
  const tz = useVenueTimezone();
  const [filters, setFilters] = useState<PayoutAccountFilters>(EMPTY_PAYOUT_FILTERS);
  const q = useDebounced(filters.q);
  const query = payoutAccountsQuery({ ...filters, q });
  const list = useLoad((signal) => fetchSaPayoutAccounts(query, signal), [query]);
  const [changed, setChanged] = useState<Readonly<Record<string, PayoutAccountListItem>>>({});
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [dialog, setDialog] = useState<{ kind: 'reveal' | 'change'; row: PayoutAccountListItem } | null>(null);

  // Mientras hay una cuenta a la vista: cuenta atrás y, a los 30 s, se tapa.
  useEffect(() => {
    if (!revealed) return undefined;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= revealed.until) setRevealed(null);
    }, 1000);
    return () => clearInterval(timer);
  }, [revealed]);

  return (
    <div className="np-sa-stack">
      <SectionHead
        kicker="Compañeras de todos los locales"
        title="Cuentas de cobro"
        sub="Siempre tapadas. Verlas enteras o cambiarlas pide tu código 2FA y queda en el registro."
      />
      <div className="np-sa-toolbar" role="search">
        <Input style={FILTER_FIELD}
          label="Buscar"
          type="search"
          value={filters.q}
          onChange={(e) => setFilters({ ...filters, q: e.target.value })}
          placeholder="Nombre o email"
        />
        <Select style={FILTER_SELECT} label="Local" value={filters.venueId} onChange={(e) => setFilters({ ...filters, venueId: e.target.value })}>
          <option value="">Todos</option>
          {(sa.venues ?? []).map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </Select>
        <Select style={FILTER_SELECT} label="Método" value={filters.method} onChange={(e) => setFilters({ ...filters, method: e.target.value })}>
          <option value="">Todos</option>
          <PayoutMethodOptions />
        </Select>
        <CheckRow
          checked={filters.onlyMissing}
          onChange={(on) => setFilters({ ...filters, onlyMissing: on })}
          label="Solo sin cuenta"
        />
        <CheckRow
          checked={filters.includeInactive}
          onChange={(on) => setFilters({ ...filters, includeInactive: on })}
          label="Con las de baja"
        />
      </div>

      <LoadGate loaded={list} what="las cuentas de cobro">
        {(items) => {
          const rows = items.map((r) => changed[r.userId] ?? r);
          if (rows.length === 0) return <p className="np-sa-empty">Ninguna compañera con ese filtro.</p>;
          return (
            <Card className="np-table-host" style={{ padding: 0, overflow: 'hidden' }}>
              <div className="np-sa-scroll-x">
                <table className="np-table">
                  <thead>
                    <tr>
                      <th>Compañera</th>
                      <th>Local</th>
                      <th>Método</th>
                      <th>Cuenta</th>
                      <th>Alias</th>
                      <th>Cambiada</th>
                      <th aria-label="Acciones" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const shown = revealed?.userId === r.userId ? revealed : null;
                      return (
                        <tr key={r.userId}>
                          <td data-label="Compañera" data-card="title">
                            {personName(r)}
                            {!r.active ? <span className="np-sa-dim np-sa-small"> · de baja</span> : null}
                          </td>
                          <td data-label="Local">{r.venue.name}</td>
                          <td data-label="Método">{r.payoutMethod ? PAYOUT_METHOD_SHORT[r.payoutMethod] : 'Sin cuenta'}</td>
                          <td data-label="Cuenta" className="np-sa-mono">
                            {shown ? (
                              <span className="np-sa-revealed">
                                <span className="np-sa-break">{shown.account.payoutAddress ?? '—'}</span>
                                <span className="np-sa-dim np-sa-small" aria-live="polite">
                                  Se tapa en {revealSecondsLeft(shown.until, now)} s
                                </span>
                                {shown.account.payoutAddress ? <CopyButton text={shown.account.payoutAddress} /> : null}
                              </span>
                            ) : (
                              r.payoutAddressMasked ?? '—'
                            )}
                          </td>
                          <td data-label="Alias">{r.payoutLabel ?? '—'}</td>
                          <td data-label="Cambiada">{formatDateTime(r.updatedAt, tz, 'date')}</td>
                          <td data-label="" data-card="actions">
                            <div className="np-sa-btn-row">
                              {r.hasPayoutAccount && !shown ? (
                                <SmallButton onClick={() => setDialog({ kind: 'reveal', row: r })}>Ver completa</SmallButton>
                              ) : null}
                              {shown ? <SmallButton onClick={() => setRevealed(null)}>Tapar</SmallButton> : null}
                              <SmallButton onClick={() => setDialog({ kind: 'change', row: r })}>Cambiar</SmallButton>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          );
        }}
      </LoadGate>

      {dialog?.kind === 'reveal' ? (
        <StepUpDialog
          title="Ver la cuenta entera"
          action="payout.reveal"
          summary={`Vas a ver entera la cuenta de cobro de ${personName(dialog.row)} durante ${REVEAL_SECONDS} s. Queda en el registro.`}
          reasonPlaceholder="Por ejemplo: comprobar el pago de anoche"
          submitLabel="Ver cuenta"
          onSubmit={async (values) => {
            const account = await revealSaPayoutAccount(dialog.row.userId, values);
            const at = Date.now();
            setNow(at);
            setRevealed({ userId: dialog.row.userId, account, until: at + REVEAL_SECONDS * 1000 });
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'change' ? (
        <ChangePayoutDialog
          row={dialog.row}
          knownAddress={revealed?.userId === dialog.row.userId ? revealed.account : null}
          onClose={() => setDialog(null)}
          onSaved={(item) => {
            setChanged((prev) => ({ ...prev, [item.userId]: item }));
            setRevealed((prev) => (prev?.userId === item.userId ? null : prev));
            setDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ChangePayoutDialog({
  row,
  knownAddress,
  onClose,
  onSaved,
}: {
  row: PayoutAccountListItem;
  /** La cuenta entera si se acaba de ver (si no, se escribe de nuevo). */
  knownAddress: PayoutAccountFull | null;
  onClose: () => void;
  onSaved: (item: PayoutAccountListItem) => void;
}) {
  const [value, setValue] = useState<PayoutValue | null>(null);
  const payload = payoutUpdatePayload(value);
  const name = personName(row);
  const summary =
    payload.ok && payload.value.payoutMethod
      ? `Vas a cambiar la cuenta de cobro de ${name} a ${PAYOUT_METHOD_SHORT[payload.value.payoutMethod]} ${maskPayoutTarget(payload.value.payoutAddress ?? '')}. Sus próximos pagos irán ahí.`
      : payload.ok
        ? `Vas a quitar la cuenta de cobro de ${name}: no se le podrá pagar hasta que tenga otra.`
        : `Vas a cambiar la cuenta de cobro de ${name}.`;

  return (
    <StepUpDialog
      title={`Cuenta de cobro de ${name}`}
      action="payout.update"
      summary={summary}
      validate={() => (payload.ok ? null : payload.error)}
      reasonPlaceholder="Por ejemplo: la compañera cambió de banco"
      submitLabel="Guardar cuenta"
      width="36rem"
      onSubmit={async (values) => {
        if (!payload.ok) throw new Error(payload.error);
        onSaved(await updateSaPayoutAccount(row.userId, payload.value, values));
      }}
      onClose={onClose}
    >
      <PayoutMethodForm
        method={row.payoutMethod}
        address={knownAddress?.payoutAddress ?? null}
        metadata={knownAddress?.payoutMetadata ?? null}
        label={row.payoutLabel}
        onChange={setValue}
      />
      {row.hasPayoutAccount && !knownAddress ? (
        <p className="np-sa-help">
          La cuenta de ahora está tapada ({row.payoutAddressMasked}): escribe la nueva entera.
        </p>
      ) : null}
    </StepUpDialog>
  );
}
