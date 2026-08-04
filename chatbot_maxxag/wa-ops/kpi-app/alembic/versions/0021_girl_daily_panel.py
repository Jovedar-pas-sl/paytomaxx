"""girl daily-panel fields: hours_today + send_photo.

  * girl.hours_today  TEXT NULL  — operator-set availability hours for today, free
                                   text (e.g. "16:00–02:00"). Surfaced to Sara so she
                                   can tell a client when a girl is in.
  * girl.send_photo   BOOLEAN NOT NULL DEFAULT true — whether Sara may send THIS
                                   girl's photo card. Lets the operator mute a girl's
                                   photo without taking her offline.

Additive — server_default keeps existing rows valid; no backfill, no CONCURRENTLY.

Revision ID: 0021
Revises: 0020
Create Date: 2026-06-30 12:00:00
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    op.add_column("girl", sa.Column("hours_today", sa.Text(), nullable=True))
    op.add_column(
        "girl",
        sa.Column(
            "send_photo",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )
    # Ficha master switch: false = web mode (auto-sync), true = backoffice/manual.
    op.add_column(
        "casa_profile",
        sa.Column(
            "manual_mode",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("casa_profile", "manual_mode")
    op.drop_column("girl", "send_photo")
    op.drop_column("girl", "hours_today")
