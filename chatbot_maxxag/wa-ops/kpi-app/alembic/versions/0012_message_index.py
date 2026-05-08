"""message: compound index on (conversation_id, created_at DESC)

Hot path: every chat list render does a subquery
  (SELECT body FROM message WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1)
plus another for direction. With 135k+ rows today and growing daily, a simple
btree on conversation_id alone forces a sort. Compound index covers the
ordering and lets the LIMIT 1 stop on the first row.

Revision ID: 0012
Revises: 0011
Create Date: 2026-05-08 10:00:00
"""
from __future__ import annotations

from alembic import op


revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    # CONCURRENTLY = no exclusive lock on `message`, webhook inserts keep
    # flowing during the build. Required because we run the migration on a
    # live system that's continuously ingesting WhatsApp messages.
    # CONCURRENTLY can't run inside a transaction, so we COMMIT first and
    # reopen one for Alembic's bookkeeping at the end.
    op.execute("COMMIT")
    op.execute(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_message_conv_created_desc "
        "ON message (conversation_id, created_at DESC)"
    )
    op.execute("BEGIN")


def downgrade() -> None:
    op.execute("COMMIT")
    op.execute("DROP INDEX CONCURRENTLY IF EXISTS ix_message_conv_created_desc")
    op.execute("BEGIN")
