-- Extensiones requeridas por NightPay
-- Este script se ejecuta automáticamente al crear el contenedor Postgres (docker-entrypoint-initdb.d)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
-- pg_partman se instalará en fase posterior cuando haya volumen
