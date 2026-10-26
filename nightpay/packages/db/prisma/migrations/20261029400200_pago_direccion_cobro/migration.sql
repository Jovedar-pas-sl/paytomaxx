-- La dirección a la que se pagó a la chica (o al camarero), guardada al
-- apuntar el pago (revisión total 2026-10-26, DIN-6). La verificación on-chain
-- comparaba con la dirección que la persona tuviera EN ESE MOMENTO: cambiarla
-- después del pago cambiaba el resultado (un encargado podía pagarse a sí
-- mismo, poner su cartera como la de la chica y verificar: MATCHED).
--
-- NULL = pago anterior a esta migración: se sigue comparando con la dirección
-- actual, como hasta ahora. '' = la persona no tenía dirección al pagarle: no
-- se verifica on-chain (se confirma a mano). Columna nueva que admite NULL: no
-- reescribe la tabla y el API anterior (start-first) sigue insertando sin ella.
-- Idempotente.
SET lock_timeout = '5s';

ALTER TABLE "operator_payouts" ADD COLUMN IF NOT EXISTS "paidToAddress" TEXT;
