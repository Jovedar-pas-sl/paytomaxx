#!/bin/bash
# ══════════════════════════════════════════════════════════════════
# Init script for Postgres 16 — runs once on first boot.
# Creates the single kpi DB + user. Chatwoot and Evolution DBs are
# no longer created; the KPI app owns the inbox tables directly
# (see kpi-app/alembic/versions/0003_inbox_tables.py).
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

echo "[init-db] Creating KPI user + database..."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
    CREATE USER kpi WITH PASSWORD '${KPI_DB_PASSWORD}';
    CREATE DATABASE kpi OWNER kpi;
EOSQL

echo "[init-db] Installing extensions in kpi DB..."
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname kpi <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS "pg_trgm";
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";
EOSQL

echo "[init-db] Done."
