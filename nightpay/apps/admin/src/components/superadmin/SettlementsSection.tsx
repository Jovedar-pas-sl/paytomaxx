'use client';

import { useState } from 'react';
import { Button, Card, Input, Select } from '@nightpay/ui';
import {
  OXIOPAY_SETTLEMENTS_LABEL,
  formatIbanGroups,
  settlementNightLabel,
  type OxioPayPayee,
  type SettlementDetail,
} from '@nightpay/contracts';
import { madridToday } from '@/lib/dates';
import {
  downloadSaSettlement,
  fetchSaPayee,
  fetchSaSettlement,
  fetchSaSettlementSettings,
  fetchSaSettlements,
  generateSaSettlement,
  recordSaSettlementPayment,
  setSaPayee,
  setSaSettlementStart,
  voidSaSettlement,
} from '@/lib/endpoints/superadmin';
import { formatEur } from '@/lib/money';
import {
  EMPTY_SETTLEMENT_FILTERS,
  SETTLEMENT_STATUS_FILTERS,
  isDuplicatePaymentError,
  lastMondayBefore,
  mondayProblem,
  paymentFormFor,
  paymentMismatch,
  paymentPayload,
  paymentSummary,
  settlementsQuery,
  startWeekSummary,
  weekStartProblem,
  type PaymentForm,
  type SettlementFilters,
} from '@/lib/oxiopay-settlements';
import { formatIbanInput, holderProblem, ibanProblem } from '@/lib/superadmin/iban';
import '../../styles/panel-liquidacion.css';
import { Notice } from '../Notice';
import { SettlementRow } from '../OxioPaySettlementsPanel';
import { SettlementView } from '../settlements/SettlementView';
import { useSa } from './context';
import { StepUpDialog } from './StepUpDialog';
import { BackButton, CheckRow, Figure, LoadGate, MetaList, SectionHead, SmallButton } from './ui';
import { useDebounced, useLoad, type Loaded } from './use-load';

/** Los motivos de la consola no salen nunca al local (ni en su panel ni en el documento). */
const INTERNAL_REASON_LABEL = 'Motivo (solo lo ve OxioPay; queda en el registro)';

/**
 * «Liquidaciones OxioPay» de todos los locales: lo pendiente de cobrar, la
 * lista con filtros, la ficha (apuntar lo recibido, anular, generar otra vez)
 * y la cuenta de OxioPay para las transferencias. Todo lo que cambia, con 2FA.
 */
export function SettlementsSection() {
  const sa = useSa();
  const [openId, setOpenId] = useState<string | null>(null);
  const [filters, setFilters] = useState<SettlementFilters>(EMPTY_SETTLEMENT_FILTERS);
  const [generating, setGenerating] = useState(false);
  const q = useDebounced(filters.q);
  const query = settlementsQuery({ ...filters, q });
  const list = useLoad((signal) => fetchSaSettlements(query, signal), [query]);
  const settings = useLoad((signal) => fetchSaSettlementSettings(signal), []);
  const set = (key: keyof SettlementFilters) => (e: { target: { value: string } }) => setFilters({ ...filters, [key]: e.target.value });

  if (openId) {
    return (
      <SettlementDetailView
        id={openId}
        onOpen={setOpenId}
        onBack={() => {
          setOpenId(null);
          list.reload();
        }}
      />
    );
  }

  return (
    <div className="np-sa-stack">
      <SectionHead
        kicker="Lo que los locales deben a OxioPay"
        title={OXIOPAY_SETTLEMENTS_LABEL}
        sub="Una por local y semana (de lunes 08:00 a lunes 08:00), emitida el lunes por la mañana con las cifras del mapa del dinero. Se paga por transferencia con su referencia."
        actions={<Button onClick={() => setGenerating(true)}>Generar una semana</Button>}
      />
      <LoadGate loaded={list} what="las liquidaciones">
        {(page) => (
          <>
            <Card>
              <dl className="np-sa-figs">
                <Figure label="Pendiente de cobrar" value={formatEur(page.totals.pendingCents)} hero note={`${page.totals.pendingCount} sin pagar entera`} />
                <Figure
                  label="Con más de 7 días"
                  value={formatEur(page.totals.overdueCents)}
                  alert={page.totals.overdueCount > 0}
                  note={`${page.totals.overdueCount} ${page.totals.overdueCount === 1 ? 'liquidación' : 'liquidaciones'}`}
                />
              </dl>
            </Card>
            {page.payeeMissing ? (
              <Notice tone="warning">Falta la cuenta de OxioPay: las liquidaciones salen sin el IBAN para la transferencia. Ponla abajo.</Notice>
            ) : null}
            <div className="np-sa-toolbar" role="search">
              <Select label="Local" value={filters.venueId} onChange={set('venueId')}>
                <option value="">Todos</option>
                {(sa.venues ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
              <Select label="Negocio" value={filters.businessId} onChange={set('businessId')}>
                <option value="">Todos</option>
                {(sa.businesses ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
              <Select label="Estado" value={filters.status} onChange={set('status')}>
                {SETTLEMENT_STATUS_FILTERS.map((s) => (
                  <option key={s.value || 'all'} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
              <Input label="Semanas desde" type="date" value={filters.from} onChange={set('from')} />
              <Input label="Hasta" type="date" value={filters.to} onChange={set('to')} />
              <Input label="Referencia" type="search" value={filters.q} onChange={set('q')} placeholder="OXP-2026-S44" autoComplete="off" />
            </div>
            {page.items.length === 0 ? (
              <p className="np-sa-empty">Ninguna liquidación con ese filtro.</p>
            ) : (
              <ul className="np-liq-list">
                {page.items.map((item) => (
                  <li key={item.id}>
                    <SettlementRow item={item} showVenue onOpen={() => setOpenId(item.id)} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </LoadGate>
      <StartWeekCard settings={settings} />
      <PayeeCard onSaved={list.reload} />
      {generating ? (
        <GenerateDialog
          startWeek={settings.data?.startWeek ?? null}
          onClose={() => setGenerating(false)}
          onDone={(d) => {
            setGenerating(false);
            setOpenId(d.id);
          }}
        />
      ) : null}
    </div>
  );
}

function SettlementDetailView({ id, onBack, onOpen }: { id: string; onBack: () => void; onOpen: (id: string) => void }) {
  const detail = useLoad((signal) => fetchSaSettlement(id, signal), [id]);
  const [dialog, setDialog] = useState<'pay' | 'void' | 'regenerate' | null>(null);

  return (
    <div className="np-sa-stack np-sa-detail">
      <BackButton onClick={onBack}>Todas las liquidaciones</BackButton>
      <LoadGate loaded={detail} what="la liquidación">
        {(d) => (
          <>
            <MetaList
              items={[
                ['Local', d.party.venueName],
                ['Negocio', d.party.businessName ? `${d.party.businessName}${d.party.businessTaxId ? ` · ${d.party.businessTaxId}` : ''}` : 'Sin negocio'],
                ...(d.replacesId ? ([['Sustituye a', 'una anulada de la misma semana']] as Array<[string, string]>) : []),
              ]}
            />
            <SettlementView
              detail={d}
              audience="superadmin"
              download={(kind) => downloadSaSettlement(d.id, kind)}
              actions={
                <>
                  {d.status === 'ISSUED' || d.status === 'PARTIALLY_PAID' ? (
                    <Button type="button" onClick={() => setDialog('pay')}>
                      Apuntar pago
                    </Button>
                  ) : null}
                  {d.status === 'ISSUED' ? (
                    <Button type="button" variant="danger" onClick={() => setDialog('void')}>
                      Anular
                    </Button>
                  ) : null}
                  {d.status === 'VOID' ? (
                    <Button type="button" onClick={() => setDialog('regenerate')}>
                      Generar otra vez
                    </Button>
                  ) : null}
                </>
              }
            />
            {dialog === 'pay' ? (
              <PaymentDialog
                detail={d}
                onClose={() => setDialog(null)}
                onDone={(next) => {
                  detail.setData(next);
                  setDialog(null);
                }}
              />
            ) : null}
            {dialog === 'void' ? (
              <StepUpDialog
                title="Anular la liquidación"
                action="settlement.void"
                danger
                intro={
                  <p className="np-sa-text">
                    Solo se anula si no tiene pagos. Lo suyo vuelve a estar sin liquidar: se puede generar otra vez (con /R2 al final de la
                    referencia) o entra la semana siguiente como ajuste. El local ve que está anulada, no el motivo.
                  </p>
                }
                summary={`Vas a anular ${d.reference} (${formatEur(d.totalCents)}) de ${d.party.venueName}.`}
                reasonLabel={INTERNAL_REASON_LABEL}
                reasonPlaceholder="Por ejemplo: faltaba un cobro del viernes"
                submitLabel="Anular"
                onSubmit={async ({ totpCode, reason }) => {
                  detail.setData(await voidSaSettlement(d.id, { totpCode, reason }));
                  setDialog(null);
                }}
                onClose={() => setDialog(null)}
              />
            ) : null}
            {dialog === 'regenerate' ? (
              <StepUpDialog
                title="Generar otra vez"
                action="settlement.generate"
                summary={`Vas a generar otra vez la liquidación de ${d.party.venueName} de la semana ${d.isoWeek} de ${d.isoYear}, con las cifras de ahora.`}
                reasonLabel={INTERNAL_REASON_LABEL}
                reasonPlaceholder="Por ejemplo: corregido el cobro que faltaba"
                submitLabel="Generar"
                onSubmit={async ({ totpCode, reason }) => {
                  const fresh = await generateSaSettlement({
                    venueId: d.venue.id,
                    week: mondayOf(d),
                    totpCode,
                    ...(reason ? { reason } : {}),
                  });
                  setDialog(null);
                  onOpen(fresh.id);
                }}
                onClose={() => setDialog(null)}
              />
            ) : null}
          </>
        )}
      </LoadGate>
    </div>
  );
}

/** El lunes (AAAA-MM-DD) de la semana de una liquidación: el de su primera noche. */
function mondayOf(d: SettlementDetail): string {
  return d.nights[0]?.day ?? d.periodFrom.slice(0, 10);
}

function PaymentDialog({ detail: d, onClose, onDone }: { detail: SettlementDetail; onClose: () => void; onDone: (d: SettlementDetail) => void }) {
  const today = madridToday();
  const [form, setForm] = useState<PaymentForm>(() => paymentFormFor(d, today));
  const set = (key: keyof PaymentForm) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  const [duplicate, setDuplicate] = useState(false);
  const [otherTransfer, setOtherTransfer] = useState(false);
  const mismatch = paymentMismatch(form, d.pendingCents);
  const parsed = paymentPayload(form, d.pendingCents, today, duplicate && otherTransfer);
  const setReference = (e: { target: { value: string } }) => {
    setForm({ ...form, bankReference: e.target.value });
    setDuplicate(false);
    setOtherTransfer(false);
  };

  return (
    <StepUpDialog
      title="Apuntar pago"
      action="settlement.pay"
      intro={
        <p className="np-sa-text">
          Lo recibido por transferencia ({d.reference}). Pendiente: <strong>{formatEur(d.pendingCents)}</strong>. Si es menos, queda pendiente
          lo que falta.
        </p>
      }
      summary={parsed.ok ? paymentSummary(d, parsed.value.amountCents) : 'Rellena el importe, el día y la referencia del banco.'}
      validate={() => {
        if (!parsed.ok) return parsed.error;
        return duplicate && !otherTransfer ? 'Esa referencia del banco ya está apuntada: si es otro abono, márcalo; si no, no lo apuntes dos veces.' : null;
      }}
      submitLabel="Apuntar pago"
      onSubmit={async ({ totpCode }) => {
        if (!parsed.ok) throw new Error(parsed.error);
        try {
          onDone(await recordSaSettlementPayment(d.id, { ...parsed.value, totpCode }));
        } catch (err) {
          if (isDuplicatePaymentError(err)) setDuplicate(true);
          throw err;
        }
      }}
      onClose={onClose}
    >
      <div className="np-sa-grid-2">
        <Input label="Importe recibido" inputMode="decimal" value={form.amount} onChange={set('amount')} autoComplete="off" />
        <Input label="Día del abono" type="date" value={form.paidOn} max={today} onChange={set('paidOn')} />
      </div>
      <Input
        label="Referencia del banco"
        value={form.bankReference}
        onChange={setReference}
        placeholder="La del movimiento en el extracto"
        maxLength={140}
        autoComplete="off"
        spellCheck={false}
      />
      {duplicate ? (
        <CheckRow
          checked={otherTransfer}
          onChange={setOtherTransfer}
          label="Es otro abono con la misma referencia"
          help="Márcalo solo si en el extracto hay dos movimientos distintos. Queda en el registro."
        />
      ) : null}
      <Input
        label={mismatch ? 'Motivo (el importe no es lo pendiente; solo lo ve OxioPay)' : 'Motivo · solo si el importe no es lo pendiente (solo lo ve OxioPay)'}
        value={form.reason}
        onChange={set('reason')}
        placeholder="Por ejemplo: pagó a cuenta, el resto la semana que viene"
        maxLength={500}
        required={mismatch}
      />
    </StepUpDialog>
  );
}

function GenerateDialog({
  startWeek,
  onClose,
  onDone,
}: {
  startWeek: string | null;
  onClose: () => void;
  onDone: (d: SettlementDetail) => void;
}) {
  const sa = useSa();
  const today = madridToday();
  const [venueId, setVenueId] = useState('');
  const [week, setWeek] = useState(() => lastMondayBefore(today));
  const venue = (sa.venues ?? []).find((v) => v.id === venueId);

  return (
    <StepUpDialog
      title="Generar una semana"
      action="settlement.generate"
      intro={
        <p className="np-sa-text">
          El repaso del lunes las genera solo. Esto es para una semana que no salió (o la de un local cuya liquidación se anuló). Si ya hay una,
          no se duplica.
        </p>
      }
      summary={venue ? `Vas a generar la liquidación de ${venue.name} de la semana que empieza el ${week}.` : 'Elige el local y la semana.'}
      validate={() => (!venueId ? 'Elige el local.' : weekStartProblem(week, today, startWeek))}
      reasonLabel={INTERNAL_REASON_LABEL}
      reasonPlaceholder="Por ejemplo: el servidor estuvo parado el lunes"
      submitLabel="Generar"
      onSubmit={async ({ totpCode, reason }) => {
        onDone(await generateSaSettlement({ venueId, week, totpCode, ...(reason ? { reason } : {}) }));
      }}
      onClose={onClose}
    >
      <Select label="Local" value={venueId} onChange={(e) => setVenueId(e.target.value)}>
        <option value="">Elige un local</option>
        {(sa.venues ?? []).map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </Select>
      <Input
        label="Lunes en que empieza la semana"
        type="date"
        value={week}
        onChange={(e) => setWeek(e.target.value)}
        hint="De lunes 08:00 a lunes 08:00 (hora de Madrid)."
        error={week ? (weekStartProblem(week, today, startWeek) ?? undefined) : undefined}
      />
    </StepUpDialog>
  );
}

/** «Lun 2 nov 2026»: el lunes a las 08:00 en que empieza a liquidarse. */
function mondayLabel(day: string): string {
  const label = settlementNightLabel(day);
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} ${day.slice(0, 4)}`;
}

function StartWeekCard({ settings }: { settings: Loaded<{ startWeek: string | null }> }) {
  const [editing, setEditing] = useState(false);

  return (
    <Card>
      <div className="np-sa-stack-sm">
        <SectionHead
          level={3}
          title="Semana de inicio"
          sub="La primera semana que se liquida. Nada anterior entra nunca, ni como ajuste de semanas anteriores."
          actions={
            <SmallButton variant="primary" onClick={() => setEditing(true)} disabled={!settings.data && !settings.error}>
              Cambiar
            </SmallButton>
          }
        />
        <LoadGate loaded={settings} what="la semana de inicio">
          {(s) =>
            s.startWeek ? (
              <MetaList items={[['Desde', `${mondayLabel(s.startWeek)}, 08:00 (hora de Madrid)`]]} />
            ) : (
              <p className="np-sa-text">Aún no está fijada: al arrancar, el servidor la pone en el próximo lunes.</p>
            )
          }
        </LoadGate>
      </div>
      {editing ? (
        <StartWeekDialog
          current={settings.data?.startWeek ?? null}
          onClose={() => setEditing(false)}
          onSaved={(startWeek) => {
            settings.setData({ startWeek });
            setEditing(false);
          }}
        />
      ) : null}
    </Card>
  );
}

function StartWeekDialog({ current, onClose, onSaved }: { current: string | null; onClose: () => void; onSaved: (startWeek: string) => void }) {
  const [week, setWeek] = useState(current ?? '');
  const problem = mondayProblem(week);

  return (
    <StepUpDialog
      title="Semana de inicio"
      action="settlement.startWeek"
      intro={
        <p className="np-sa-text">
          El repaso del lunes no liquida ninguna semana anterior a esta, y lo de antes tampoco entra como ajuste. Las liquidaciones ya emitidas
          no cambian.
        </p>
      }
      summary={problem ? 'Elige un lunes.' : startWeekSummary(week, current)}
      validate={() => problem ?? (week === current ? 'Es la misma semana de ahora.' : null)}
      reasonPlaceholder="Por ejemplo: empezamos a cobrar la comisión esta semana"
      submitLabel="Guardar"
      onSubmit={async ({ totpCode, reason }) => {
        onSaved((await setSaSettlementStart({ startWeek: week, reason, totpCode })).startWeek);
      }}
      onClose={onClose}
    >
      <Input
        label="Lunes en que empieza"
        type="date"
        value={week}
        onChange={(e) => setWeek(e.target.value)}
        hint="Desde ese lunes a las 08:00 (hora de Madrid)."
        error={week ? (problem ?? undefined) : undefined}
      />
    </StepUpDialog>
  );
}

function PayeeCard({ onSaved }: { onSaved: () => void }) {
  const payee = useLoad((signal) => fetchSaPayee(signal), []);
  const [editing, setEditing] = useState(false);

  return (
    <Card>
      <div className="np-sa-stack-sm">
        <SectionHead
          level={3}
          title="Cuenta de OxioPay"
          sub="La que sale en todas las liquidaciones para la transferencia (también en las ya emitidas sin pagar)."
          actions={
            <SmallButton variant="primary" onClick={() => setEditing(true)}>
              {payee.data ? 'Cambiar' : 'Poner la cuenta'}
            </SmallButton>
          }
        />
        <LoadGate loaded={payee} what="la cuenta de OxioPay">
          {(p) => (p ? <PayeeMeta payee={p} /> : <p className="np-sa-text">Aún no hay cuenta: las liquidaciones lo avisan.</p>)}
        </LoadGate>
      </div>
      {editing ? (
        <PayeeDialog
          current={payee.data}
          onClose={() => setEditing(false)}
          onSaved={(next) => {
            payee.setData(next);
            setEditing(false);
            onSaved();
          }}
        />
      ) : null}
    </Card>
  );
}

function PayeeMeta({ payee }: { payee: OxioPayPayee }) {
  return (
    <MetaList
      items={[
        ['Nombre', payee.name],
        ['IBAN', <span key="iban" className="np-sa-mono">{formatIbanGroups(payee.iban)}</span>],
        ['Titular', payee.holder],
      ]}
    />
  );
}

function PayeeDialog({ current, onClose, onSaved }: { current: OxioPayPayee | null; onClose: () => void; onSaved: (p: OxioPayPayee) => void }) {
  const [name, setName] = useState(current?.name ?? 'OxioPay');
  const [iban, setIban] = useState(current ? formatIbanInput(current.iban) : '');
  const [holder, setHolder] = useState(current?.holder ?? '');
  const ibanError = iban.replace(/\s/g, '').length >= 15 ? ibanProblem(iban) : null;

  return (
    <StepUpDialog
      title="Cuenta de OxioPay"
      action="settlement.payee"
      summary={`Las liquidaciones dirán que se pague a ${holder.trim() || '…'} en ${iban || '…'}.`}
      validate={() => (name.trim().length < 2 ? 'Pon el nombre.' : (ibanProblem(iban) ?? holderProblem(holder)))}
      submitLabel="Guardar cuenta"
      onSubmit={async ({ totpCode }) => {
        onSaved(await setSaPayee({ name: name.trim(), iban: iban.replace(/\s/g, ''), holder: holder.trim(), totpCode }));
      }}
      onClose={onClose}
    >
      <Input label="Nombre (sale como «De» en la liquidación)" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} />
      <Input
        label="IBAN"
        value={iban}
        onChange={(e) => setIban(formatIbanInput(e.target.value))}
        placeholder="ES91 2100 0418 4502 0005 1332"
        autoComplete="off"
        spellCheck={false}
        error={ibanError ?? undefined}
        hint="Se comprueba el dígito de control antes de pedirte el código."
      />
      <Input label="Titular de la cuenta" value={holder} onChange={(e) => setHolder(e.target.value)} maxLength={160} />
      <p className="np-sa-help">Queda en el registro (con el IBAN tapado).</p>
    </StepUpDialog>
  );
}
