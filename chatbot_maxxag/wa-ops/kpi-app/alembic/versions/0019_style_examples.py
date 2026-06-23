"""casa style examples — Sara learns from how human receptionists reply.

A daily harvest cron samples real HUMAN outbound messages per casa (and the
client message they answered) into `casa_style_example` as status='pending'. A
super-admin approves/rejects them under /ajustes/estilo. Approved examples are
injected into Sara's system prompt as a "this is how the team replies" style
block (imitate tone/length/length, NEVER quote).

  * casa_style_example.casa_id     INT  NOT NULL  — conversation.inbox_id (the casa)
  * .lang        TEXT NULL          — detected reply language (es/en/fr/it) or NULL
  * .kind        TEXT NOT NULL      — 'pair' (client_msg + reply) | 'phrase' (reply only)
  * .client_msg  TEXT NULL          — the client message answered (NULL for 'phrase')
  * .reply_msg   TEXT NOT NULL      — the human reply to imitate (PII-scrubbed)
  * .status      TEXT NOT NULL      — 'pending' | 'approved' | 'rejected'
  * .source      TEXT NOT NULL      — 'cron' | 'manual'
  * .dedup_key   TEXT NOT NULL      — folded reply; UNIQUE per casa → idempotent harvest
  * .created_at / .decided_at

Plain create_table + two indexes; no backfill, no CONCURRENTLY.

Revision ID: 0019
Revises: 0018
Create Date: 2026-06-19 12:00:00
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    op.create_table(
        "casa_style_example",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("casa_id", sa.Integer, nullable=False),
        sa.Column("lang", sa.Text(), nullable=True),
        sa.Column("kind", sa.Text(), nullable=False, server_default="phrase"),
        sa.Column("client_msg", sa.Text(), nullable=True),
        sa.Column("reply_msg", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("source", sa.Text(), nullable=False, server_default="cron"),
        sa.Column("dedup_key", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Idempotent harvest: the same (casa, reply) is inserted at most once.
    op.create_index(
        "ux_style_example_casa_dedup",
        "casa_style_example",
        ["casa_id", "dedup_key"],
        unique=True,
    )
    # Review queue + injection lookups both filter by (casa_id, status).
    op.create_index(
        "ix_style_example_casa_status",
        "casa_style_example",
        ["casa_id", "status"],
    )


def downgrade() -> None:
    op.drop_index("ix_style_example_casa_status", table_name="casa_style_example")
    op.drop_index("ux_style_example_casa_dedup", table_name="casa_style_example")
    op.drop_table("casa_style_example")
