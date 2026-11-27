-- Yavin, elección por cobro (26-nov-2026, decisión del dueño): en un local con
-- las dos pasarelas (BBVA y Yavin), el camarero elige en cada cobro con tarjeta.
-- payments."cardGateway": lo que eligió (REDSYS o YAVIN); NULL = no eligió (los
-- cobros de antes y los locales con una sola pasarela): la decide el servidor
-- (apps/api/src/modules/gateways/card-gateway.ts). Sin DEFAULT: no reescribe la
-- tabla. Se puede repetir.

SET lock_timeout = '5s';

ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "cardGateway" "Provider";
