'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Button, Card, Input, Modal, StaffAvatar } from '@nightpay/ui';
import { createOperator, fetchOperators, fetchVenueSettings, type Operator } from '@/lib/api';
import { formatPercent, parsePercentToBps } from '@/lib/commission';
import { keepIfSame } from '@/lib/diff';
import { formatEur } from '@/lib/money';
import { usePolling } from '@/lib/use-polling';
import { Notice } from './Notice';
import { OperatorDetailModal } from './OperatorDetailModal';
import { Pill, type Tone } from './Pill';

interface Props {
  isOwner: boolean;
}

const POLL_MS = 10_000;

/** Lo que se enseña tras crear una chica (el aviso solo con el API nuevo). */
interface CreateResult {
  inviteUrl: string;
  emailSent: boolean;
  notice?: string;
}

export function OperatorsPanel({ isOwner }: Props) {
  /** null = aún no ha llegado la primera lista. */
  const [operators, setOperators] = useState<Operator[] | null>(null);
  /** Camareros con parte de las invitaciones (se les paga igual que a las chicas). */
  const [camareros, setCamareros] = useState<Operator[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createResult, setCreateResult] = useState<CreateResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterNeedsHelp, setFilterNeedsHelp] = useState(false);

  const list = operators ?? [];
  const needsHelpCount = list.filter((o) => o.needsHelpWallet || o.needsHelpDocs).length;
  const visibleOperators = filterNeedsHelp ? list.filter((o) => o.needsHelpWallet || o.needsHelpDocs) : list;

  const reload = usePolling(
    async (signal) => {
      try {
        const [fresh, waiters] = await Promise.all([fetchOperators(), fetchOperators('WAITER').catch(() => null)]);
        if (signal.aborted) return true;
        setOperators((prev) => keepIfSame(prev, fresh));
        if (waiters) setCamareros((prev) => keepIfSame(prev, waiters.filter(hasEarnings)));
        setError(null);
        return true;
      } catch (err) {
        if (!signal.aborted) setError((err as Error).message);
        return false;
      }
    },
    { intervalMs: POLL_MS },
    [],
  );

  const selected = [...list, ...camareros].find((o) => o.id === selectedId) ?? null;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '1rem', flexWrap: 'wrap' }}>
        <h2 style={sectionTitle}>Operadoras</h2>
        {needsHelpCount > 0 ? (
          <label
            style={{
              ...helpFilter,
              background: filterNeedsHelp ? 'var(--np-pill-warning-bg)' : 'var(--np-surface-2)',
              color: filterNeedsHelp ? 'var(--np-warning)' : 'var(--np-text)',
            }}
          >
            <input
              type="checkbox"
              checked={filterNeedsHelp}
              onChange={(e) => setFilterNeedsHelp(e.target.checked)}
              style={{ margin: 0 }}
            />
            Solo las que piden ayuda ({needsHelpCount})
          </label>
        ) : null}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.75rem' }}>
          <Button variant="ghost" onClick={reload}>
            Refrescar
          </Button>
          <Button onClick={() => setCreateOpen(true)} data-tour="chicas-nueva">+ Nueva operadora</Button>
        </div>
      </div>

      {error ? (
        <Notice tone="danger" action={{ label: 'Reintentar', onClick: reload }}>
          {error}
          {operators ? ' · se siguen enseñando los últimos datos.' : ''}
        </Notice>
      ) : null}

      <Card className="np-table-host" style={{ padding: 0, overflow: 'hidden' }} data-tour="chicas-tabla">
        <div style={{ overflowX: 'auto' }}>
          <table className="np-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Email</th>
                <th style={numCol}>Comisión</th>
                <th style={numCol}>Saldo pendiente</th>
                <th style={numCol}>Pagado total</th>
                <th>Estado</th>
                <th aria-label="Acciones" />
              </tr>
            </thead>
            <tbody>
              {operators === null ? (
                <tr>
                  <td colSpan={7} style={emptyCell}>
                    {error ? 'No se pudo cargar la lista.' : 'Cargando…'}
                  </td>
                </tr>
              ) : visibleOperators.length === 0 ? (
                <tr>
                  <td colSpan={7} style={emptyCell}>
                    {list.length === 0
                      ? 'Aún no hay operadoras. Crea la primera con "+ Nueva operadora".'
                      : 'Ninguna coincide con el filtro.'}
                  </td>
                </tr>
              ) : (
                visibleOperators.map((op, i) => {
                  const needsHelp = op.needsHelpWallet || op.needsHelpDocs;
                  return (
                    <tr
                      key={op.id}
                      className="np-row-link"
                      onClick={() => setSelectedId(op.id)}
                      style={{
                        cursor: 'pointer',
                        background: needsHelp ? 'var(--np-pill-warning-bg)' : undefined,
                      }}
                    >
                      <td data-label="Nombre" data-card="title">
                        <PersonName id={op.id} name={op.displayName} photoHash={op.photoHash} fallback="—" />
                        {needsHelp ? (
                          <Pill tone="warning" style={{ marginLeft: '0.5rem' }}>
                            pide ayuda
                          </Pill>
                        ) : null}
                      </td>
                      <td data-label="Email" style={cellMeta}>
                        {op.email}
                      </td>
                      <td data-label="Comisión" className="np-num" style={numCell}>
                        {formatPercent(op.commissionBps)}
                      </td>
                      <td
                        data-label="Saldo pendiente"
                        data-card="amount"
                        className="np-num"
                        style={{
                          ...numCell,
                          color: op.balance.pendingCents < 0 ? 'var(--np-danger)' : 'var(--np-text)',
                        }}
                      >
                        {formatEur(op.balance.pendingCents)}
                      </td>
                      <td data-label="Pagado total" className="np-num" style={numCell}>
                        {formatEur(op.balance.paidCents)}
                      </td>
                      <td data-label="Estado" data-card="status" style={cellMeta} {...(i === 0 ? { 'data-tour': 'chicas-estado' } : {})}>
                        <OnboardingBadge operator={op} />
                      </td>
                      <td data-label="Acciones" data-card="actions" style={{ textAlign: 'right' }}>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedId(op.id);
                          }}
                        >
                          Ver
                        </Button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {camareros.length > 0 ? <CamarerosCard camareros={camareros} onOpen={setSelectedId} /> : null}

      <CreateOperatorModal
        open={createOpen}
        isOwner={isOwner}
        onClose={() => {
          setCreateOpen(false);
          setCreateResult(null);
        }}
        onCreated={(result) => {
          setCreateResult(result);
          reload();
        }}
        result={createResult}
      />

      {selected ? (
        <OperatorDetailModal
          key={selected.id}
          operator={selected}
          isOwner={isOwner}
          onClose={() => setSelectedId(null)}
          onChanged={reload}
        />
      ) : null}
    </section>
  );
}

/** Un camarero con algo de las invitaciones (ganado alguna vez, o pendiente). */
function hasEarnings(o: Operator): boolean {
  return o.balance.count > 0 || o.balance.pendingCents !== 0;
}

/**
 * Los camareros con parte de las invitaciones («Copa con invitación»): de
 * fábrica no tienen (el local se queda lo que no es de la chica); salen si el
 * dueño les dio algo en Ajustes, o si les queda algo de antes. Lo que se les
 * debe y lo pagado; su ficha es la de las chicas, con el mismo botón para pagarles.
 */
/** El nombre con su foto (o las iniciales sobre un color) en las listas. */
function PersonName({ id, name, photoHash, fallback }: { id: string; name: string | null; photoHash?: string | null; fallback: string }) {
  const shown = name?.trim() || fallback;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.625rem', minWidth: 0, verticalAlign: 'middle' }}>
      <StaffAvatar userId={id} hash={photoHash ?? null} name={name?.trim() || null} size={32} />
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{shown}</span>
    </span>
  );
}

function CamarerosCard({ camareros, onOpen }: { camareros: Operator[]; onOpen: (id: string) => void }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }} aria-labelledby="np-camareros" data-tour="chicas-camareros">
      <h3 id="np-camareros" style={{ ...sectionTitle, fontSize: '1rem' }}>
        Camareros · su parte de las invitaciones
      </h3>
      <Card className="np-table-host" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="np-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th style={numCol}>A pagar</th>
                <th style={numCol}>Pagado total</th>
                <th aria-label="Acciones" />
              </tr>
            </thead>
            <tbody>
              {camareros.map((c) => (
                <tr key={c.id} className="np-row-link" onClick={() => onOpen(c.id)} style={{ cursor: 'pointer' }}>
                  <td data-label="Nombre" data-card="title">
                    <PersonName id={c.id} name={c.displayName} photoHash={c.photoHash} fallback={c.email} />
                  </td>
                  <td
                    data-label="A pagar"
                    data-card="amount"
                    className="np-num"
                    style={{ ...numCell, color: c.balance.pendingCents < 0 ? 'var(--np-danger)' : 'var(--np-text)' }}
                  >
                    {formatEur(c.balance.pendingCents)}
                  </td>
                  <td data-label="Pagado total" className="np-num" style={numCell}>
                    {formatEur(c.balance.paidCents)}
                  </td>
                  <td data-label="Acciones" data-card="actions" style={{ textAlign: 'right' }}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen(c.id);
                      }}
                    >
                      Ver
                    </Button>
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

/**
 * Comisión de una chica nueva creada por el encargado: la del local para
 * servicios de chica (solo el dueño la elige).
 */
function useVenueChicaCommission(enabled: boolean) {
  const [bps, setBps] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setError(null);
    fetchVenueSettings()
      .then((s) => {
        if (!cancelled) setBps(s.operatorCommissionDefaults.CHICA_SERVICE);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, attempt]);

  return { bps, error, retry: () => setAttempt((n) => n + 1) };
}

function CreateOperatorModal({
  open,
  isOwner,
  onClose,
  onCreated,
  result,
}: {
  open: boolean;
  isOwner: boolean;
  onClose: () => void;
  onCreated: (r: CreateResult) => void;
  result: CreateResult | null;
}) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [commissionPct, setCommissionPct] = useState('15');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const venueCommission = useVenueChicaCommission(open && !isOwner);

  useEffect(() => {
    if (open && !result) {
      setEmail('');
      setDisplayName('');
      setCommissionPct('15');
      setError(null);
      setCopied(false);
    }
  }, [open, result]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const commissionBps = isOwner ? parsePercentToBps(commissionPct) : venueCommission.bps;
    if (commissionBps === null) {
      setError(
        isOwner
          ? 'Comisión inválida: un porcentaje de 0 a 100 (por ejemplo 15 o 15,5).'
          : 'Falta la comisión del local: vuelve a cargarla.',
      );
      return;
    }
    setSubmitting(true);
    try {
      const res = await createOperator({
        email: email.trim().toLowerCase(),
        displayName: displayName.trim(),
        commissionBps,
      });
      onCreated({ inviteUrl: res.inviteUrl, emailSent: res.emailSent, notice: res.notice });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('No se pudo copiar: selecciona el enlace y cópialo a mano.');
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Nueva operadora" width="32rem">
      {result ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <Notice tone="success">
            Operadora creada.{' '}
            {result.emailSent
              ? 'Email de invitación enviado.'
              : 'No hay SMTP configurado: copia el enlace y mándaselo por WhatsApp.'}
          </Notice>
          {result.notice ? <Notice tone="info">{result.notice}</Notice> : null}
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'stretch' }}>
            <code style={urlCode}>{result.inviteUrl}</code>
            <Button variant="ghost" size="md" onClick={copy}>
              {copied ? 'Copiado' : 'Copiar'}
            </Button>
          </div>
          {error ? (
            <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
              {error}
            </p>
          ) : null}
          <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--np-text-dim)' }}>
            El enlace vale 24 h y deja de valer tras el primer uso.
          </p>
          <Button onClick={onClose}>Cerrar</Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <Input
            label="Nombre"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            maxLength={80}
            placeholder="Ana"
          />
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="ana@ejemplo.com"
          />
          {isOwner ? (
            <Input
              label="Comisión (%)"
              type="text"
              inputMode="decimal"
              value={commissionPct}
              onChange={(e) => setCommissionPct(e.target.value)}
              required
              hint="Ejemplo: 15 = 15%"
            />
          ) : venueCommission.error ? (
            <Notice tone="danger" action={{ label: 'Reintentar', onClick: venueCommission.retry }}>
              No se pudo cargar la comisión del local: {venueCommission.error}
            </Notice>
          ) : (
            <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--np-text-mute)' }}>
              Comisión: la del local para servicios de compañera
              {venueCommission.bps !== null ? ` (${formatPercent(venueCommission.bps)})` : '…'}. Solo el dueño
              puede cambiarla.
            </p>
          )}
          {error ? (
            <p role="alert" style={{ color: 'var(--np-danger)', margin: 0, fontSize: '0.875rem' }}>
              {error}
            </p>
          ) : null}
          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
            <Button variant="ghost" type="button" onClick={onClose} style={{ flex: 1 }}>
              Cancelar
            </Button>
            <Button
              type="submit"
              loading={submitting}
              disabled={!isOwner && venueCommission.bps === null}
              style={{ flex: 1 }}
            >
              Crear y generar invitación
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function onboardingDisplay(operator: Operator): { label: string; tone: Tone } {
  const status = operator.onboardingStatus ?? 'NEW';
  if (!operator.active) return { label: 'Inactiva', tone: 'neutral' };
  if (status === 'READY') return { label: 'Operativa', tone: 'success' };
  if (status === 'BLOCKED') return { label: 'Bloqueada', tone: 'danger' };
  if (status === 'BINANCE_PENDING') return { label: 'KYC pendiente', tone: 'info' };
  if (status === 'INVITE_ACTIVATED') return { label: 'Activada', tone: 'warning' };
  if (status === 'PROFILE_CREATED') {
    return { label: operator.invitedAt ? 'Invitada' : 'Perfil creado', tone: 'warning' };
  }
  if (operator.invitedAt) return { label: 'Invitada', tone: 'warning' };
  return { label: 'Nueva', tone: 'neutral' };
}

function OnboardingBadge({ operator }: { operator: Operator }) {
  const display = onboardingDisplay(operator);
  return <Pill tone={display.tone}>{display.label}</Pill>;
}

const sectionTitle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--np-t-h2)',
  fontWeight: 600,
};

const helpFilter: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  fontSize: '0.875rem',
  minHeight: 'var(--np-filter-h)',
  border: '1px solid var(--np-border-hi)',
  borderRadius: 'var(--np-r-sm)',
  padding: '0 0.75rem',
  cursor: 'pointer',
};

const numCol: CSSProperties = { textAlign: 'right' };
const numCell: CSSProperties = { textAlign: 'right', fontWeight: 400 };
const cellMeta: CSSProperties = { color: 'var(--np-text-mute)' };
const emptyCell: CSSProperties = {
  textAlign: 'center',
  color: 'var(--np-text-dim)',
  padding: '3rem 1rem',
  fontSize: '0.875rem',
};
const urlCode: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  padding: '0 0.875rem',
  fontFamily: 'var(--np-font-mono)',
  fontSize: '0.875rem',
  background: 'var(--np-bg)',
  color: 'var(--np-text-mute)',
  border: '1px solid var(--np-border)',
  borderRadius: 'var(--np-r-md)',
  overflowX: 'auto',
  whiteSpace: 'nowrap',
  height: '3rem',
  minWidth: 0,
};
