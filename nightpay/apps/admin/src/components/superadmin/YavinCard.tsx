'use client';

import { useState } from 'react';
import { Button, Card, Input } from '@nightpay/ui';
import type { YavinVenueStatus } from '@nightpay/contracts';
import { formatDateTime } from '@/lib/dates';
import { clearSaYavin, fetchSaYavin, setSaYavinKey, setSaYavinUse } from '@/lib/endpoints/superadmin';
import { useVenueTimezone } from '@/lib/venue-context';
import { Pill } from '../Pill';
import { StepUpDialog } from './StepUpDialog';
import { ErrorLine, MetaList, SectionHead, StickyActions } from './ui';
import { useLoad } from './use-load';

/** Nombre de la pasarela de siempre, para la persona que lo lee. */
function baseLabel(provider: string | null): string {
  if (!provider) return 'Ninguna';
  return provider === 'REDSYS' ? 'BBVA (Redsys)' : provider;
}

/** El problema de la clave antes de pedir el código; null si vale. */
export function yavinKeyProblem(key: string): string | null {
  const k = key.trim();
  if (!k) return 'Pega la clave de API de Yavin';
  if (/\s/.test(k)) return 'La clave no lleva espacios';
  if (k.length < 8) return 'La clave de Yavin es más larga';
  return null;
}

/**
 * Yavin en el local: segunda pasarela de tarjeta, un enlace de pago online que
 * el cliente abre con el QR del cobro. Solo sale si el servidor tiene Yavin
 * encendido. La clave nunca se enseña: solo si está guardada y desde cuándo.
 */
export function YavinCard({ venueId, venueName }: { venueId: string; venueName: string }) {
  const loaded = useLoad((signal) => fetchSaYavin(venueId, signal), [venueId]);
  const tz = useVenueTimezone();
  const [dialog, setDialog] = useState<'key' | 'use' | 'stop' | 'clear' | null>(null);
  const [apiKey, setApiKey] = useState('');

  if (loaded.error) return <Card><ErrorLine>{loaded.error}</ErrorLine></Card>;
  const s: YavinVenueStatus | null = loaded.data;
  // Servidor sin Yavin (o aún cargando): nada.
  if (!s) return null;

  function done(next: YavinVenueStatus): void {
    loaded.setData(next);
    setDialog(null);
    setApiKey('');
  }

  return (
    <Card>
      <div className="np-sa-stack-sm">
        <SectionHead
          level={3}
          title="Yavin (pago con QR)"
          sub="Segunda pasarela de tarjeta: el cliente paga en la página de Yavin desde el QR del cobro. No es un datáfono."
          actions={s.inUse ? <Pill tone="success">En uso</Pill> : <Pill tone="neutral">Sin usar</Pill>}
        />
        <MetaList
          items={[
            ['Clave de API', s.configured && s.savedAt ? `Guardada el ${formatDateTime(s.savedAt, tz, 'date')}` : 'Sin clave'],
            ['Pasarela de siempre', baseLabel(s.baseGateway)],
          ]}
        />
        <StickyActions sticky={false}>
          <Button type="button" variant={s.configured ? 'ghost' : 'primary'} onClick={() => setDialog('key')}>
            {s.configured ? 'Cambiar clave' : 'Guardar clave'}
          </Button>
          {s.configured && !s.selected ? (
            <Button type="button" variant="primary" onClick={() => setDialog('use')}>
              Usar Yavin
            </Button>
          ) : null}
          {s.selected ? (
            <Button type="button" variant="ghost" onClick={() => setDialog('stop')}>
              Dejar de usar Yavin
            </Button>
          ) : null}
          {s.configured || s.selected ? (
            <Button type="button" variant="ghost" onClick={() => setDialog('clear')}>
              Quitar Yavin
            </Button>
          ) : null}
        </StickyActions>
      </div>

      {dialog === 'key' ? (
        <StepUpDialog
          title={s.configured ? 'Cambiar la clave de Yavin' : 'Guardar la clave de Yavin'}
          action="venue.yavinKey"
          summary={`Vas a guardar la clave de API de Yavin de ${venueName}${s.configured ? ', en lugar de la que tenía' : ''}. Se guarda cifrada y no se vuelve a enseñar.`}
          validate={() => yavinKeyProblem(apiKey)}
          submitLabel="Guardar clave"
          onSubmit={async ({ totpCode }) => done(await setSaYavinKey(venueId, { apiKey: apiKey.trim(), totpCode }))}
          onClose={() => {
            setDialog(null);
            setApiKey('');
          }}
        >
          <Input
            label="Clave de API de Yavin"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            hint="La de my.yavin.com, pestaña API, del contrato de este local."
          />
        </StepUpDialog>
      ) : null}

      {dialog === 'use' || dialog === 'stop' ? (
        <StepUpDialog
          title={dialog === 'use' ? 'Usar Yavin en el local' : 'Dejar de usar Yavin'}
          action="venue.yavinUse"
          summary={
            dialog === 'use'
              ? `Los cobros con tarjeta de ${venueName} podrán ir por Yavin (enlace de pago con QR). Las cargas de saldo y los reservados siguen con ${baseLabel(s.baseGateway)}.`
              : `Los cobros nuevos de ${venueName} vuelven a ir solo por ${baseLabel(s.baseGateway)}. Los que ya están abiertos con Yavin siguen su curso.`
          }
          submitLabel={dialog === 'use' ? 'Usar Yavin' : 'Dejar de usar Yavin'}
          onSubmit={async ({ totpCode }) => done(await setSaYavinUse(venueId, { use: dialog === 'use', totpCode }))}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog === 'clear' ? (
        <StepUpDialog
          title="Quitar Yavin del local"
          action="venue.yavinClear"
          summary={`Vas a borrar la clave de Yavin de ${venueName} y dejar de usarlo. Los cobros ya abiertos con Yavin siguen su curso.`}
          submitLabel="Quitar Yavin"
          danger
          onSubmit={async ({ totpCode, reason }) => done(await clearSaYavin(venueId, { totpCode, reason }))}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </Card>
  );
}
