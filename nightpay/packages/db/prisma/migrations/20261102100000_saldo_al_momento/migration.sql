-- «Saldo al momento» (2026-10-29): que la página del saldo del cliente y la
-- app del personal se enteren al momento de que un saldo o un cobro del saldo
-- cambió, en vez de preguntar cada 1,5–3 segundos (04-codigo.md H-1, H-2).
--
-- Cada cambio que interesa hace pg_notify en el canal np_wallet_events, con
-- un mensaje corto y sin datos del cliente:
--   w:<id del saldo>            el saldo cambió (saldo, estado, «Me voy», PIN,
--                               código, enlace, fusión) o una devolución suya
--   c:<id del cobro>:<estado>   un cobro del saldo cambió de estado (pagado,
--                               cancelado, caducado, pagado con tarjeta…)
-- Postgres solo lo entrega al hacer COMMIT (un cobro que se deshace no avisa)
-- y a todas las conexiones que escuchan: cada réplica del API escucha con una
-- (WalletEventsListener) y avisa a sus páginas (SSE) y sockets.
--
-- Con triggers ningún camino que escriba se escapa: cobros (QR, NFC, PIN,
-- datáfono, sin Face ID), recargas (tarjeta, efectivo, anuladas), devoluciones,
-- fusiones, la consola, los barridos o un UPDATE a mano.
--
-- Solo avisa cuando cambia lo que se ve (WHEN): un PIN fallado o el contador
-- del NFC sin PIN no avisan. Si nadie escucha, el aviso no hace nada. Las
-- funciones son SECURITY INVOKER (las de siempre): valen con el superusuario
-- `np` y con `oxiopay_app` (docs/DB-ROLE.md); pg_notify no pide permisos.
--
-- Se puede repetir: CREATE OR REPLACE. CREATE TRIGGER bloquea un momento cada
-- tabla: si choca con el lock_timeout (otra transacción con ella), se relanza
-- el despliegue.

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION np_notify_wallet_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('np_wallet_events', 'w:' || NEW.id::text);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION np_notify_wallet_payout_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('np_wallet_events', 'w:' || NEW."walletId"::text);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION np_notify_wallet_charge_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('np_wallet_events', 'c:' || NEW.id::text || ':' || NEW.status);
  RETURN NULL;
END;
$$;

-- El saldo: lo que enseña su página (ClientWalletState).
CREATE OR REPLACE TRIGGER np_wallet_change_notify
  AFTER UPDATE ON client_wallets
  FOR EACH ROW
  WHEN (
    OLD."balanceCents" IS DISTINCT FROM NEW."balanceCents"
    OR OLD.status IS DISTINCT FROM NEW.status
    OR OLD."closeRequestedAt" IS DISTINCT FROM NEW."closeRequestedAt"
    OR OLD."mergedIntoId" IS DISTINCT FROM NEW."mergedIntoId"
    OR OLD."shortCode" IS DISTINCT FROM NEW."shortCode"
    OR OLD."qrToken" IS DISTINCT FROM NEW."qrToken"
    OR (OLD."pinHash" IS NULL) IS DISTINCT FROM (NEW."pinHash" IS NULL)
  )
  EXECUTE FUNCTION np_notify_wallet_change();

-- «Me voy»: los pasos de la devolución (pedida → aprobada → hecha).
CREATE OR REPLACE TRIGGER np_wallet_payout_notify
  AFTER INSERT OR UPDATE OF status ON wallet_payouts
  FOR EACH ROW
  EXECUTE FUNCTION np_notify_wallet_payout_change();

-- El cobro del saldo: lo que espera la app del personal.
CREATE OR REPLACE TRIGGER np_wallet_charge_notify
  AFTER UPDATE ON wallet_charge_requests
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION np_notify_wallet_charge_change();
