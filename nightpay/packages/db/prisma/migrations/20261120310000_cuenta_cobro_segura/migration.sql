-- Cuenta de cobro segura (19-nov-2026). La cuenta de cobro del personal
-- ("payoutAddress") y su titular ("payoutMetadata".accountHolder) pasan a
-- guardarse cifrados (pa1:..., AES-256-GCM con ENCRYPTION_KEK, que no está en
-- la base). Para enseñarlas sin abrirlas, la versión tapada va aparte:
--   payoutAddressMasked     "ES91 •••• •••• 1332", "T…9f2a", "a•••@gmail.com"
--   payoutHolderMasked      "M••• L•••"
-- Y lo de los cambios de cuenta:
--   payoutAccountChangedAt  último cambio (aviso a la compañera en su app)
--   payoutHoldUntil         hasta cuándo no se le paga a la cuenta nueva (48 h; no en efectivo)
--   payoutNoticeSeenAt      cuándo vio ella el aviso («Entendido»)
--
-- Las filas que ya existen NO se tocan aquí (la base no tiene la clave): las
-- cifra el relleno del API al arrancar, justo después de esta migración
-- (apps/api/src/modules/operators/payout-account-backfill.ts; se puede
-- repetir). Mientras tanto el API lee las dos formas.
--
-- Columnas sin valor por defecto (NULL): no reescriben la tabla. Se puede repetir.

SET lock_timeout = '5s';

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "payoutAddressMasked" TEXT,
  ADD COLUMN IF NOT EXISTS "payoutHolderMasked" TEXT,
  ADD COLUMN IF NOT EXISTS "payoutAccountChangedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "payoutHoldUntil" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "payoutNoticeSeenAt" TIMESTAMPTZ;
