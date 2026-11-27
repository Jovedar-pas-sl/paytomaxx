'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Banner,
  Button,
  EmptyState,
  Etiqueta,
  Skeleton,
  formatDateTime,
  formatRelative,
  useConfirm,
  useToast,
} from '@nightpay/ui';
import type { PartnerConnectionView, PartnerConnectionsOverview, PartnerKeyIssued } from '@nightpay/contracts';
import {
  fetchPartnerConnections,
  pausePartnerConnection,
  revokePartnerConnection,
} from '@/lib/endpoints/partner-connections';
import {
  ACTION_LABELS,
  SCOPE_LABELS,
  connectionActions,
  connectionNotices,
  connectionTag,
  type ConnectionAction,
} from '@/lib/partner-connections';
import { useVenueTimezone } from '@/lib/venue-context';
import '../../../styles/panel-partners.css';
import { SettingsCard } from '../SettingsBits';
import { ConnectSheet } from './ConnectSheet';
import { KeyIssuedSheet } from './KeyIssuedSheet';
import { LimitsSheet } from './LimitsSheet';
import { MovementsSheet } from './MovementsSheet';
import { ResumeSheet } from './ResumeSheet';
import { RotateSheet } from './RotateSheet';

/**
 * Ajustes → «Otras plataformas» (API de socios). Las plataformas que entran
 * con una clave en el saldo del local (la primera, la red de cajeros, que
 * solo carga saldo). El dueño conecta, cambia la clave, pausa, reanuda (no la
 * pausa de OxioPay) y anula; el encargado pausa y anula. «Movimientos» (los
 * dos, también en una anulada) enseña las cargas de una noche; «Topes», solo
 * el dueño. Ningún botón añade
 * IP; la clave se ve una vez (KeyIssuedSheet) y al cerrar se suelta.
 */
export function PartnersPanel({ role }: { role: string }) {
  const isOwner = role === 'OWNER';
  const timezone = useVenueTimezone();
  const [data, setData] = useState<PartnerConnectionsOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [connecting, setConnecting] = useState(false);
  const [rotating, setRotating] = useState<PartnerConnectionView | null>(null);
  const [resuming, setResuming] = useState<PartnerConnectionView | null>(null);
  const [watching, setWatching] = useState<PartnerConnectionView | null>(null);
  const [limiting, setLimiting] = useState<PartnerConnectionView | null>(null);
  /** La respuesta con la clave: solo aquí, y a null al cerrar su hoja. */
  const [issued, setIssued] = useState<PartnerKeyIssued | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const toast = useToast();

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(null);
    fetchPartnerConnections(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setData(next);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setLoadError(err instanceof Error ? err.message : 'No se pudo cargar.');
      });
    return () => controller.abort();
  }, [attempt]);

  // Al salir de la pestaña, nada de la clave se queda.
  useEffect(() => () => setIssued(null), []);

  function keyIssued(next: PartnerKeyIssued): void {
    setConnecting(false);
    setRotating(null);
    setIssued(next);
    reload();
  }

  async function pause(c: PartnerConnectionView): Promise<void> {
    const sure = await confirm({
      title: `¿Pausar ${c.partnerName}?`,
      body: isOwner
        ? 'Su clave deja de funcionar hasta que la reanudes (con tu 2FA).'
        : 'Su clave deja de funcionar hasta que el dueño la reanude.',
      confirmLabel: 'Pausar',
      tone: 'primary',
    });
    if (sure) await act(c, () => pausePartnerConnection(c.id), `${c.partnerName}, en pausa.`);
  }

  async function revoke(c: PartnerConnectionView): Promise<void> {
    const sure = await confirm({
      title: `¿Anular la clave de ${c.partnerName}?`,
      body: 'Deja de funcionar para siempre. Para volver a conectarla hará falta una clave nueva.',
      confirmLabel: 'Anular',
      tone: 'danger',
    });
    if (sure) await act(c, () => revokePartnerConnection(c.id), `La clave de ${c.partnerName}, anulada.`);
  }

  async function act(c: PartnerConnectionView, call: () => Promise<PartnerConnectionView>, done: string): Promise<void> {
    setBusy(c.id);
    setRowError(null);
    try {
      await call();
      toast.show(done, { tone: 'success' });
      reload();
    } catch (err) {
      setRowError({ id: c.id, message: err instanceof Error ? err.message : 'No se pudo hacer. Vuelve a probar.' });
    } finally {
      setBusy(null);
    }
  }

  function run(action: ConnectionAction, c: PartnerConnectionView): void {
    setRowError(null);
    if (action === 'movements') setWatching(c);
    else if (action === 'limits') setLimiting(c);
    else if (action === 'rotate') setRotating(c);
    else if (action === 'resume') setResuming(c);
    else if (action === 'pause') void pause(c);
    else void revoke(c);
  }

  if (!data) {
    return (
      <SettingsCard title="Otras plataformas">
        {loadError ? (
          <Banner tone="danger" action={{ label: 'Reintentar', onClick: reload }}>
            No se pudieron cargar las plataformas: {loadError}
          </Banner>
        ) : (
          <div className="np-ptn-list" aria-busy="true">
            <Skeleton height="9rem" />
            <Skeleton height="9rem" />
          </div>
        )}
      </SettingsCard>
    );
  }

  const live = data.connections.filter((c) => c.state !== 'revoked');
  const revoked = data.connections.filter((c) => c.state === 'revoked');
  const connectable = data.partners.filter((p) => !live.some((c) => c.partnerId === p.id));
  const emailOf = (partnerId: string) => data.partners.find((p) => p.id === partnerId)?.contactEmail ?? null;

  return (
    <SettingsCard
      title="Otras plataformas"
      tour="plataformas"
      hint="Plataformas que entran en el saldo de tu local con una clave: por ahora, los cajeros que cargan saldo aquí."
    >
      {loadError ? (
        <Banner tone="warning" action={{ label: 'Reintentar', onClick: reload }}>
          No se pudo actualizar: {loadError}
        </Banner>
      ) : null}

      {isOwner && connectable.length > 0 ? (
        <div className="np-ptn-actions">
          <Button type="button" onClick={() => setConnecting(true)}>
            Conectar una plataforma
          </Button>
        </div>
      ) : null}

      {live.length === 0 ? (
        <EmptyState
          icon="lock"
          title="Ninguna plataforma conectada"
          text={
            !isOwner
              ? 'Las conecta el dueño.'
              : connectable.length > 0
                ? 'Conecta una para darle su clave.'
                : 'Cuando OxioPay dé de alta una (con su KYB y su contrato de datos), podrás conectarla aquí.'
          }
          compact
        />
      ) : (
        <ul className="np-ptn-list">
          {live.map((c) => (
            <ConnectionCard
              key={c.id}
              c={c}
              role={role}
              timezone={timezone}
              busy={busy === c.id}
              error={rowError?.id === c.id ? rowError.message : null}
              onAction={(a) => run(a, c)}
            />
          ))}
        </ul>
      )}

      {revoked.length > 0 ? (
        <details className="np-ptn-old">
          <summary>Anuladas ({revoked.length})</summary>
          <ul className="np-ptn-list">
            {revoked.map((c) => (
              <ConnectionCard
                key={c.id}
                c={c}
                role={role}
                timezone={timezone}
                busy={false}
                error={null}
                onAction={(a) => (a === 'movements' ? setWatching(c) : undefined)}
              />
            ))}
          </ul>
        </details>
      ) : null}

      {connecting ? (
        <ConnectSheet partners={connectable} emailEnabled={data.emailEnabled} onClose={() => setConnecting(false)} onIssued={keyIssued} />
      ) : null}
      {rotating ? (
        <RotateSheet
          connection={rotating}
          emailEnabled={data.emailEnabled}
          maskedEmail={emailOf(rotating.partnerId)}
          onClose={() => setRotating(null)}
          onIssued={keyIssued}
        />
      ) : null}
      {resuming ? (
        <ResumeSheet
          connection={resuming}
          onClose={() => setResuming(null)}
          onDone={(next) => {
            setResuming(null);
            toast.show(`${next.partnerName}, en marcha otra vez.`, { tone: 'success' });
            reload();
          }}
        />
      ) : null}
      {watching ? <MovementsSheet connection={watching} timezone={timezone} onClose={() => setWatching(null)} /> : null}
      {limiting ? (
        <LimitsSheet
          connection={limiting}
          onClose={() => setLimiting(null)}
          onDone={(next) => {
            setLimiting(null);
            toast.show(`Topes de ${next.partnerName}, guardados.`, { tone: 'success' });
            reload();
          }}
        />
      ) : null}
      {issued ? (
        <KeyIssuedSheet
          issued={issued}
          timezone={timezone}
          onClose={() => setIssued(null)}
          onRotate={() => {
            const c = issued.connection;
            setIssued(null);
            setRotating(c);
          }}
        />
      ) : null}
      {confirmDialog}
    </SettingsCard>
  );
}

function ConnectionCard({
  c,
  role,
  timezone,
  busy,
  error,
  onAction,
}: {
  c: PartnerConnectionView;
  role: string;
  timezone: string;
  busy: boolean;
  error: string | null;
  onAction: (action: ConnectionAction) => void;
}) {
  const tag = connectionTag(c);
  const actions = connectionActions(c, role);
  const notices = connectionNotices(c, role);
  const now = new Date();
  const scopes = c.scopes.map((s) => `${SCOPE_LABELS[s]}${c.pausedScopes.includes(s) ? ' (en pausa)' : ''}`).join(' · ');
  const rows: Array<[string, string]> = [
    ['Puede', scopes],
    ['Desde', c.ipAllowlist.length > 0 ? c.ipAllowlist.join(', ') : 'Cualquier IP (solo en pruebas)'],
    ['Clave', `Termina en ${c.keyHint.slice(-4)} · desde el ${formatDateTime(c.keyCreatedAt, timezone, 'dayMonthYear')}`],
    ['Caduca', c.keyExpiresAt ? formatDateTime(c.keyExpiresAt, timezone, 'dayMonthYear') : 'Sin caducidad'],
    ['Último uso', c.lastUsedAt ? `${formatRelative(c.lastUsedAt, now, timezone)}${c.lastUsedIp ? ` · ${c.lastUsedIp}` : ''}` : 'Aún no'],
  ];
  if (c.previousKeyUntil) rows.push(['La anterior', `vale hasta ${formatDateTime(c.previousKeyUntil, timezone, 'short')}`]);

  return (
    <li className="np-ptn-card" data-state={c.state}>
      <div className="np-ptn-card-head">
        <h3 className="np-ptn-name">{c.partnerName}</h3>
        <span className="np-ptn-tags" data-tour="plataformas-estado">
          <Etiqueta tone={tag.tone}>{tag.label}</Etiqueta>
          {c.mode === 'test' ? <Etiqueta tone="info">Prueba</Etiqueta> : null}
        </span>
      </div>
      {notices.map((n) => (
        <Banner
          key={n.title}
          tone={n.tone}
          title={n.title}
          action={n.action ? { label: n.action, onClick: () => onAction('rotate') } : undefined}
        >
          {n.text}
        </Banner>
      ))}
      <dl className="np-ptn-meta">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {error ? (
        <p role="alert" className="np-ptn-error">
          {error}
        </p>
      ) : null}
      {actions.length > 0 ? (
        <div className="np-ptn-actions" data-tour="plataformas-botones">
          {actions.map((a) => (
            <Button
              key={a}
              type="button"
              size="sm"
              variant={a === 'revoke' ? 'danger-outline' : 'ghost'}
              onClick={() => onAction(a)}
              loading={busy && (a === 'pause' || a === 'revoke')}
              disabled={busy}
            >
              {ACTION_LABELS[a]}
            </Button>
          ))}
        </div>
      ) : null}
    </li>
  );
}
