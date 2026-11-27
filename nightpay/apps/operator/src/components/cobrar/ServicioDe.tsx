'use client';

import type { CSSProperties } from 'react';
import { FormError, StaffAvatar } from '@nightpay/ui';
import { STICKY_ACTION_BOTTOM } from '../layout';
import { formatEur } from '@/lib/money';
import type { Cuenta } from '@/lib/cuenta';
import { servicioDe } from '@/lib/servicio';
import { colorOf, labelOf, puestoChip, type CobrarContext } from './cobrar-context';
import { Chip, ScreenHeader } from './ScreenHeader';
import { GatewayButtons } from './LaCuenta';
import type { CardGateway } from '@/lib/api-cobro';
import styles from './cobrar.module.css';

interface Props {
  ctx: CobrarContext;
  who: string;
  /** La cuenta que se cobra. */
  cuenta: Cuenta;
  /** La compañera reconocida por su «Mi QR». */
  chica: { id?: string; name: string; photoHash?: string | null };
  /** «QR o ficha»: el cobro de siempre (su QR, la ficha o el PIN). */
  onQr: () => void;
  /** Local con BBVA y Yavin: un botón por pasarela en lugar de «QR o ficha» (null: sin elección). */
  gateways?: readonly CardGateway[] | null;
  onGateway?: (gateway: CardGateway) => void;
  /** «Tarjeta en el datáfono» (solo si el local lo tiene). */
  onPos?: () => void;
  /** «Otra compañera»: volver a escanear. */
  onOtra: () => void;
  onBack: () => void;
  busy: boolean;
  error: string | null;
}

/**
 * «Servicio de Nerea» (cobro por el encargado): tras leer su «Mi QR», su foto,
 * su nombre y lo de Servicios que se le apunta, antes de cobrar. Una compañera
 * por cobro: todo lo de Servicios va a ella (el aviso lo dice).
 */
export function ServicioDe({ ctx, who, cuenta, chica, onQr, gateways, onGateway, onPos, onOtra, onBack, busy, error }: Props) {
  const { serviceCents, totalCents } = servicioDe(cuenta);
  const services = labelOf(ctx, 'CHICA_SERVICE');
  const chip = puestoChip(ctx);
  return (
    <div className={styles.screen}>
      <ScreenHeader
        title={`Servicio de ${chica.name}`}
        subtitle={who}
        onBack={onBack}
        chip={chip ? <Chip color={chip.color}>{chip.label}</Chip> : null}
      />
      <div className={styles.body}>
        <div className={styles.servicioDe}>
          <StaffAvatar userId={chica.id} hash={chica.photoHash ?? null} name={chica.name} size={120} />
          <b>{chica.name}</b>
        </div>
        <div className={styles.split}>
          <span className={styles.sleg}>
            <span style={{ '--c': colorOf('CHICA_SERVICE') } as CSSProperties}>
              {services}: <b>{formatEur(serviceCents, { compact: true })}</b> → para {chica.name}
            </span>
          </span>
        </div>
        <p className={styles.muted}>{`Todo lo de ${services} va a ${chica.name}. Si algún servicio es de otra compañera, quítalo de la cuenta y cóbralo aparte.`}</p>
        <div className={styles.total}>
          <span>Total</span>
          <b>{formatEur(totalCents, { compact: true })}</b>
        </div>
      </div>
      <div className={styles.foot} style={{ '--np-foot-bottom': STICKY_ACTION_BOTTOM } as CSSProperties}>
        {gateways && onGateway ? (
          <GatewayButtons gateways={gateways} onGateway={onGateway} disabled={false} busy={busy} />
        ) : (
          <button type="button" className={`${styles.btn} ${styles.primary}`} disabled={busy} aria-busy={busy || undefined} onClick={onQr}>
            QR o ficha
          </button>
        )}
        {onPos ? (
          <button type="button" className={`${styles.btn} ${styles.ghost}`} disabled={busy} onClick={onPos}>
            Tarjeta en el datáfono
          </button>
        ) : null}
        <button type="button" className={`${styles.btn} ${styles.ghost}`} disabled={busy} onClick={onOtra}>
          Otra compañera
        </button>
        {busy ? (
          <p className={styles.muted} role="status">
            Un momento…
          </p>
        ) : null}
        {error ? (
          <FormError>
            {error}
          </FormError>
        ) : null}
      </div>
    </div>
  );
}
