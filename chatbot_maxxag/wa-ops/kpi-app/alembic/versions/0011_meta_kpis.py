"""casa_meta_analysis.kpis — single JSONB column with all numeric KPIs

The informe is now a numeric dashboard (volumen, estado, mood, tiempo, trato,
red flags). Storing everything as a single JSONB makes future additions free
— no migration needed when we want a new metric.

Revision ID: 0011
Revises: 0010
Create Date: 2026-05-08 09:00:00
"""
from __future__ import annotations

from alembic import op


revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    # Idempotent — safe to re-run.
    op.execute(
        "ALTER TABLE casa_meta_analysis "
        "ADD COLUMN IF NOT EXISTS kpis JSONB"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE casa_meta_analysis DROP COLUMN IF EXISTS kpis")
