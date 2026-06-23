"""message location coords — F3 outcall calculator capture

When an incoming WhatsApp message is a LOCATION PIN, the webhook stores its
coordinates on the message row so the auto_reply job can later detect "the client
just sent a location" and compute the outcall price deterministically.

  * message.latitude  DOUBLE PRECISION NULL
  * message.longitude DOUBLE PRECISION NULL

Both nullable with NO server_default → atomic add, no backfill, no CONCURRENTLY,
no autocommit_block needed (mirrors 0016's agent_followup_at and 0014's
agent_paused_at). NULL == "not a location message" (the overwhelmingly common
case). No index: the auto-reply job reads the latest location by conversation_id,
already covered by the existing ix_message_conv_created* indexes.

Revision ID: 0017
Revises: 0016
Create Date: 2026-06-17 12:00:00
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    # ── message.latitude / message.longitude (NULL == not a location) ──
    # Atomic add (nullable, no server_default) — see module docstring.
    op.add_column(
        "message",
        sa.Column("latitude", sa.Double(), nullable=True),
    )
    op.add_column(
        "message",
        sa.Column("longitude", sa.Double(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("message", "longitude")
    op.drop_column("message", "latitude")
