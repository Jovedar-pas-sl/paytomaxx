"""per-client memory — remember a contact's preferred language + interested girls

Per-conversation memory for the WhatsApp reply agent. A 1:1 row with conversation
(PK = conversation_id, FK CASCADE) silently remembers, scoped to the SAME
conversation/number only (the FK to conversation.id already enforces "1 conv = 1
cliente", one contact on one wa_number — never cross numbers):

  * preferred_lang TEXT NULL — the language the client tends to write in, so Sara
    can adapt without being told.
  * preferred_girls TEXT[] NULL — the girl NAMES the client showed interest in, so
    Sara may re-offer them. We store NAMES (not girl.id) on purpose: the prompt and
    photo layers already match on names (photo_select), and girl.id is unstable
    across the WordPress website re-sync (rows are upserted by (casa_id, ext_id)
    and ones absent from the feed get deactivated), so an id could dangle while a
    name survives a re-sync and still matches.
  * updated_at TIMESTAMPTZ NOT NULL DEFAULT now() — the recency clock. The read
    path applies a 90-day freshness filter (WHERE updated_at > now() - interval
    '90 days'), giving read-time expiry with no cron job.

Plain CREATE TABLE with a server-default on updated_at, so it is atomic — no
op.execute UPDATE, no CONCURRENTLY, no autocommit_block needed (mirrors 0013/0014).

Revision ID: 0015
Revises: 0014
Create Date: 2026-06-16 09:00:00
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    # ── conversation_memory (1:1 conversation, PK == FK) ─────────────
    op.create_table(
        "conversation_memory",
        sa.Column(
            "conversation_id",
            sa.BigInteger,
            sa.ForeignKey("conversation.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("preferred_lang", sa.Text, nullable=True),
        # Girl NAMES (see module docstring for why names, not girl.id).
        sa.Column("preferred_girls", postgresql.ARRAY(sa.Text), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_table("conversation_memory")
