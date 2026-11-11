'use client';

import { Button } from '@nightpay/ui';
import type { User } from '@/lib/api';
import { TwoFactorCard } from '../TwoFactorCard';
import { PasskeysCard } from './PasskeysCard';
import { SettingsCard } from './SettingsBits';

const ROLE_LABELS: Record<User['role'], string> = {
  OWNER: 'Dueño',
  MANAGER: 'Encargado',
  WAITER: 'Camarero',
  OPERATOR: 'Operadora',
};

/**
 * Ajustes → Seguridad: quién está dentro (y «Salir», que en el móvil vive
 * aquí), la verificación en dos pasos y la llave de acceso (quien no tiene 2FA).
 */
export function SecurityPanel({
  user,
  onLogout,
  loggingOut,
}: {
  user: User;
  onLogout: () => void;
  loggingOut: boolean;
}) {
  return (
    <div className="np-set-stack">
      <SettingsCard title="Tu cuenta" tour="seguridad-cuenta">
        <div className="np-set-account">
          <p>
            <strong>{user.email}</strong>
            {ROLE_LABELS[user.role]} · <code>{user.venueSlug}</code>
            {user.isSuperAdmin ? ' · super-admin' : ''}
          </p>
          <Button variant="ghost" onClick={onLogout} loading={loggingOut}>
            Salir
          </Button>
        </div>
      </SettingsCard>
      <TwoFactorCard />
      <PasskeysCard />
    </div>
  );
}
