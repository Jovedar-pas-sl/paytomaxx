-- OxioParty, «Lo que sobra» (docs/OXIOPARTY.md): la devolución que pide el
-- asistente desde la página de su pulsera, hasta el último día del local
-- (venues."refundDeadline"). Con EDITION=club (OxioPay) esta tabla no se usa.
--
--   party_refund_requests   una por petición: el importe, cómo (CARD: solo lo
--                           cargado con tarjeta, la hace el organizador a mano
--                           en el banco; TRANSFER: lo cargado en efectivo, a
--                           su IBAN; DONATE: a la comisión, hecha al momento),
--                           el IBAN (solo TRANSFER), un correo opcional para
--                           el justificante y el estado (PENDING → DONE |
--                           CANCELED), con quién y cuándo se hizo.
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
  -- El IBAN, solo y siempre en una transferencia; como lo guarda el API (sin espacios, en mayúsculas).
  CONSTRAINT "party_refund_requests_iban_check" CHECK (
    ("method" = 'TRANSFER') = ("iban" IS NOT NULL)
    AND ("iban" IS NULL OR "iban" ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$')
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
