-- Reintentos de dinero que conservan la intención original (revisión del 21-10).
-- Solo añade columnas que pueden ser NULL o con un DEFAULT constante (no
-- reescriben la tabla) y un índice único sobre una columna nueva, vacía en
-- todas las filas existentes: ninguna fila antigua cambia de comportamiento.
-- Repetible: IF NOT EXISTS en todo. Si alguien tiene la tabla bloqueada, falla
-- a los 5 s en vez de dejar en espera los cobros de detrás.
SET lock_timeout = '5s';

-- Recarga en efectivo: huella de lo pedido (destino + importe) y el recibo
-- que se enseñó, para que un reintento devuelva el mismo. NULL = anterior.
ALTER TABLE wallet_cash_topups ADD COLUMN IF NOT EXISTS "intentFingerprint" TEXT;
ALTER TABLE wallet_cash_topups ADD COLUMN IF NOT EXISTS "receipt" JSONB;

-- Devolución pedida desde el panel: la clave de la pantalla, la huella de lo
-- pedido (cobro, importe, quién) y la respuesta para devolverla al reintentar.
-- NULL = devolución sin clave (las de antes y las de otros caminos).
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS "intentFingerprint" TEXT;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS "replayResponse" JSONB;

-- Repaso del descuento a la chica: cuándo toca el siguiente intento, cuántos
-- van (la espera crece con ellos) y por qué falló el último.
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS "earningReversalRetryAt" TIMESTAMPTZ;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS "earningReversalAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS "earningReversalLastError" TEXT;

-- Una clave por local. Las filas con NULL no chocan entre sí (NULL ≠ NULL).
CREATE UNIQUE INDEX IF NOT EXISTS "refunds_tenantId_idempotencyKey_key"
  ON refunds ("tenantId", "idempotencyKey");
