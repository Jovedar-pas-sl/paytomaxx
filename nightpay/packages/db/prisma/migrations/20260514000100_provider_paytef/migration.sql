-- =========================================================================
-- Track B.1 — Añadir PAYTEF al enum Provider
-- =========================================================================
-- Paytef Payment LINK API (https://api.paytef.es/gcf/payment-link/...).
-- Coexiste con WIPAY y PEANPE; el venue elige cuál usar via GatewayCredential.
-- Hoy Paytef es el único con claves reales (empresa "Rapido Sin Riesgos").
-- =========================================================================

ALTER TYPE "Provider" ADD VALUE IF NOT EXISTS 'PAYTEF';
