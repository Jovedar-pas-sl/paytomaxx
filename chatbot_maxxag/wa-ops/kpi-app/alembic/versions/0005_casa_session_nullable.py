"""casa.waha_session nullable (legacy column)

After wa_number took over the 1:N mapping, casa.waha_session is legacy
and new casas are created without one. Relax the NOT NULL so INSERTs
that only set `name` succeed.

Revision ID: 0005
Revises: 0004
Create Date: 2026-04-23 11:00:00
"""
from __future__ import annotations

from alembic import op


revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    op.alter_column("casa", "waha_session", nullable=True)


def downgrade() -> None:
    # Best-effort: fill nulls with the casa's first wa_number.session if any
    op.execute("""
        UPDATE casa c
        SET waha_session = (SELECT session FROM wa_number w
                            WHERE w.casa_id = c.id
                            ORDER BY created_at ASC LIMIT 1)
        WHERE c.waha_session IS NULL
    """)
    op.alter_column("casa", "waha_session", nullable=False)
