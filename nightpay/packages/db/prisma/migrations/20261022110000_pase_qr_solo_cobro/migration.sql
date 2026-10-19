-- Pase de Google Wallet: el QR ya no es el enlace del saldo (/w/<token>, que
-- da todos los poderes) sino uno solo para cobrar en el datáfono con el PIN
-- (/c/<token>, ver apps/api/.../google-wallet/pass-charge-token.ts).
--
-- Solo datos, sin cambiar el esquema: los pases ya dados se marcan como «por
-- poner al día» (lastSyncedBalanceCents = -1, que no coincide con ningún
-- saldo) y el repaso de siempre (google-wallet-sync, cada ~2 min) les manda el
-- QR nuevo. wallet_passes no tiene RLS.
--
-- Idempotente: lanzada otra vez enseguida no cambia nada (los ya marcados
-- tienen -1).
UPDATE "wallet_passes"
   SET "lastSyncedBalanceCents" = -1
 WHERE "provider" = 'GOOGLE'
   AND "revokedAt" IS NULL
   AND "lastSyncedBalanceCents" >= 0;
