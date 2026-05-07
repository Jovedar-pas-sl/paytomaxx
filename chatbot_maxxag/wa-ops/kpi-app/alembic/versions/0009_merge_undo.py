"""merge_event table + message.merged_from_conv_id — undoable merges

Stores enough state to reverse a conversation merge (manual, IA-confirmed
or fully automatic) when the IA picks the wrong client.

  - message.merged_from_conv_id   → the source conv id (now deleted) the
                                     message originally belonged to.
  - merge_event                   → snapshot of source contact + conv at
                                     time of merge, plus the trigger that
                                     produced it. `undone_at` records the
                                     reversal (idempotent).

Revision ID: 0009
Revises: 0008
Create Date: 2026-04-30 18:00:00
"""
from __future__ import annotations

from alembic import op


revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    # Idempotent — re-runnable after a partial previous attempt.
    op.execute(
        "ALTER TABLE message ADD COLUMN IF NOT EXISTS merged_from_conv_id BIGINT"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_message_merged_from "
        "ON message (merged_from_conv_id) "
        "WHERE merged_from_conv_id IS NOT NULL"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS merge_event (
            id                       BIGSERIAL PRIMARY KEY,
            target_conv_id           BIGINT REFERENCES conversation(id) ON DELETE SET NULL,
            source_conv_id           BIGINT NOT NULL,
            source_casa_id           INTEGER,
            source_wa_number_id      INTEGER,
            source_contact_id        BIGINT,
            source_contact_snapshot  JSONB  NOT NULL,
            source_status            TEXT,
            source_unread_count      INTEGER NOT NULL DEFAULT 0,
            messages_moved           INTEGER NOT NULL DEFAULT 0,
            triggered_by             TEXT   NOT NULL,
            confidence               DOUBLE PRECISION,
            reasoning                TEXT,
            created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
            undone_at                TIMESTAMPTZ,
            CONSTRAINT ck_merge_event_trigger
                CHECK (triggered_by IN ('manual','ia','auto'))
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_merge_event_target_active "
        "ON merge_event (target_conv_id) "
        "WHERE undone_at IS NULL"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_merge_event_created "
        "ON merge_event (created_at DESC)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_merge_event_created")
    op.execute("DROP INDEX IF EXISTS ix_merge_event_target_active")
    op.execute("DROP TABLE IF EXISTS merge_event")
    op.execute("DROP INDEX IF EXISTS ix_message_merged_from")
    op.execute("ALTER TABLE message DROP COLUMN IF EXISTS merged_from_conv_id")
