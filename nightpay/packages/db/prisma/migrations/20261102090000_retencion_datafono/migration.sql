-- Comisión retenida de las ventas por datáfono sin prueba del banco (H-1,
-- rama feat/cobros-seguros). La regla vive en el código
-- (apps/api/src/modules/operators/bank-hold-sql.ts) y se calcula al momento:
-- una ganancia de un cobro con `pos.confirmed` o `pos.device_unproven` no se
-- paga mientras el cuadre con el banco no lo tenga casado (bank_statement_items
-- MATCHED sin supersededAt) ni el dueño lo haya liberado (`pos.bank_released`).
-- No hace falta ninguna columna ni tabla nueva: solo este índice, porque cada
-- saldo de la chica, cada pago y cada cierre pregunta «¿este cobro ya casa con
-- el banco?» por paymentId (antes solo había índices por fichero y por estado).
--
-- Solo un índice: ningún dato cambia. bank_statement_items es pequeña (una fila
-- por operación de los ficheros subidos): se construye en milisegundos. Si una
-- transacción del API anterior tiene la tabla, falla a los 5 s en vez de dejar
-- en cola los cuadres de detrás: se vuelve a desplegar (docs/DOKPLOY-STEPS.md,
-- D.8). Idempotente (IF NOT EXISTS). Con el superusuario `np` de producción o
-- con un rol sin superusuario, igual: no toca la RLS.
SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "bank_statement_items_paymentId_idx"
  ON "bank_statement_items" ("paymentId");
