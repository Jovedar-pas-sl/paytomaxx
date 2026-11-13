-- OxioParty, «Lo que sobra» (docs/OXIOPARTY.md): la devolución que pide el
-- asistente desde la página de su pulsera, hasta el último día del local
-- (venues."refundDeadline"). Con EDITION=club (OxioPay) esta tabla no se usa.
--
--   party_refund_requests   una por petición: el importe, cómo (CARD: solo lo
--                           cargado con tarjeta, la hace el organizador a mano
--                           en el banco; TRANSFER: lo cargado en efectivo, a
--                           su IBAN; DONATE: a la comisión, hecha al momento),
--                           el IBAN y el nombre del titular (solo TRANSFER: el
--                           banco comprueba que nombre e IBAN coinciden), un
--                           correo opcional para el justificante y el estado
--                           (PENDING → DONE | CANCELED), con quién y cuándo.
--
-- Del asistente, lo mínimo y solo mientras hace falta: el IBAN, el titular y
-- el correo se borran al pasar a DONE o CANCELED (lo hace el API; el CHECK
-- party_refund_requests_personal_data_check lo exige).
--
-- El saldo queda bloqueado mientras hay una pendiente (client_wallets."blockedAt"
-- con el motivo de OxioParty, que ya respetan los pagos y las recargas): no hace
-- falta columna nueva en client_wallets.
--
-- Tabla nueva y vacía: no bloquea nada. FORCE RLS como las demás tablas por
-- local (política con el local y el bypass calculados una vez por consulta,
-- 20261101090000). Todo con IF NOT EXISTS / DROP POLICY IF EXISTS: se puede repetir.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "party_refund_requests" (
  "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    UUID         NOT NULL,
  "walletId"    UUID         NOT NULL,
  "amountCents" INTEGER      NOT NULL,
  "method"      VARCHAR(10)  NOT NULL,
  "iban"        VARCHAR(34),
  "holderName"  VARCHAR(70),
  "email"       VARCHAR(254),
  "status"      VARCHAR(10)  NOT NULL DEFAULT 'PENDING',
  "createdAt"   TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "doneAt"      TIMESTAMPTZ,
  "doneById"    UUID,

  CONSTRAINT "party_refund_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "party_refund_requests_tenantId_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- Un saldo con devoluciones no se borra (el dinero que salió queda apuntado).
  CONSTRAINT "party_refund_requests_walletId_fkey" FOREIGN KEY ("walletId")
    REFERENCES "client_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "party_refund_requests_amount_check" CHECK ("amountCents" > 0 AND "amountCents" <= 100000000),
  CONSTRAINT "party_refund_requests_method_check" CHECK ("method" IN ('CARD', 'TRANSFER', 'DONATE')),
  CONSTRAINT "party_refund_requests_status_check" CHECK ("status" IN ('PENDING', 'DONE', 'CANCELED')),
  -- El IBAN, solo en una transferencia, y siempre en una pendiente; como lo
  -- guarda el API (sin espacios, en mayúsculas). Hecha o anulada, ya no está.
  CONSTRAINT "party_refund_requests_iban_check" CHECK (
    ("iban" IS NULL OR "method" = 'TRANSFER')
    AND ("method" <> 'TRANSFER' OR "status" <> 'PENDING' OR "iban" IS NOT NULL)
    AND ("iban" IS NULL OR "iban" ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$')
  ),
  -- El titular de la cuenta, igual: solo en una transferencia, siempre en una pendiente (de 2 a 70).
  CONSTRAINT "party_refund_requests_holder_check" CHECK (
    ("holderName" IS NULL OR "method" = 'TRANSFER')
    AND ("method" <> 'TRANSFER' OR "status" <> 'PENDING' OR "holderName" IS NOT NULL)
    AND ("holderName" IS NULL OR char_length(btrim("holderName")) BETWEEN 2 AND 70)
  ),
  -- Hecha o anulada: sin datos del asistente (ni IBAN, ni titular, ni correo).
  CONSTRAINT "party_refund_requests_personal_data_check" CHECK (
    "status" = 'PENDING' OR ("iban" IS NULL AND "holderName" IS NULL AND "email" IS NULL)
  ),
  CONSTRAINT "party_refund_requests_email_check" CHECK ("email" IS NULL OR "email" ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  -- Hecha ⇔ con fecha; una cancelada no lleva fecha de hecha.
  CONSTRAINT "party_refund_requests_done_check" CHECK (("status" = 'DONE') = ("doneAt" IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS "party_refund_requests_tenantId_status_createdAt_idx"
  ON "party_refund_requests"("tenantId", "status", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "party_refund_requests_walletId_status_idx"
  ON "party_refund_requests"("walletId", "status");
-- Una pendiente por saldo y método (el doble toque no pide dos veces lo mismo).
CREATE UNIQUE INDEX IF NOT EXISTS "party_refund_requests_one_pending_per_method"
  ON "party_refund_requests"("walletId", "method") WHERE "status" = 'PENDING';

ALTER TABLE "party_refund_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "party_refund_requests" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS party_refund_requests_tenant_isolation ON "party_refund_requests";
CREATE POLICY party_refund_requests_tenant_isolation ON "party_refund_requests"
  USING ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()))
  WITH CHECK ((SELECT app_rls_bypass()) OR "tenantId" = (SELECT app_current_tenant()));
