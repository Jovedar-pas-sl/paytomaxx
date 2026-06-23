"""team roles + audit log — multi-user RBAC (Fase 2 / Slice 1)

Turns the single env-admin into a real multi-user model with roles, casa
assignment for agents, a lean audit log, and per-message human attribution.

  * admin_user.name           TEXT NULL        — display name (for "quién contestó")
  * admin_user.role           TEXT NOT NULL     — super_admin | admin | agent
  * admin_user.active         BOOL NOT NULL     — deactivated users can't log in
  * user_casa(user_id,casa_id)                  — agent ↔ casa scope. No rows for an
                                                  agent == sees all (default); rows
                                                  restrict to the listed casas.
  * audit_log                                   — fine-grained, low-volume trail:
                                                  message sent (Sara/agent), login,
                                                  Sara mode change, informe delete.
  * message.sent_by_user_id   INT NULL          — who sent a HUMAN outbound message
                                                  (NULL == Sara / auto / unknown).

All columns added nullable or with a server_default → atomic, no backfill,
no CONCURRENTLY. Pre-existing admin_user rows were the lone admin, so they are
promoted to super_admin (the env-admin bootstrap in code keeps this in sync).

Revision ID: 0018
Revises: 0017
Create Date: 2026-06-17 17:30:00
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    # ── admin_user: name / role / active ─────────────────────────────
    op.add_column("admin_user", sa.Column("name", sa.Text(), nullable=True))
    op.add_column(
        "admin_user",
        sa.Column("role", sa.Text(), nullable=False, server_default="agent"),
    )
    op.add_column(
        "admin_user",
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.create_check_constraint(
        "ck_admin_user_role",
        "admin_user",
        "role IN ('super_admin','admin','agent')",
    )
    # Any pre-existing rows were the single admin → promote to super_admin.
    op.execute("UPDATE admin_user SET role = 'super_admin'")

    # ── user_casa: agent ↔ casa assignment ───────────────────────────
    op.create_table(
        "user_casa",
        sa.Column(
            "user_id",
            sa.Integer,
            sa.ForeignKey("admin_user.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "casa_id",
            sa.Integer,
            sa.ForeignKey("casa.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("user_id", "casa_id", name="pk_user_casa"),
    )
    op.create_index("ix_user_casa_user", "user_casa", ["user_id"])

    # ── audit_log: lean activity trail ───────────────────────────────
    op.create_table(
        "audit_log",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column(
            "at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        # Who did it. user_id NULL for Sara/system; actor_label is always set
        # ('Sara', the agent's name/email, or 'system') so the log reads even
        # if a user is later deleted.
        sa.Column(
            "user_id",
            sa.Integer,
            sa.ForeignKey("admin_user.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("actor_label", sa.Text, nullable=False),
        sa.Column("action", sa.Text, nullable=False),  # message_sent|login|sara_mode|informe_delete|...
        sa.Column("entity_type", sa.Text, nullable=True),  # conversation|casa|informe|...
        sa.Column("entity_id", sa.BigInteger, nullable=True),
        sa.Column("meta", postgresql.JSONB, nullable=True),
    )
    op.create_index(
        "ix_audit_log_at", "audit_log", ["at"], postgresql_ops={"at": "DESC"}
    )
    op.create_index(
        "ix_audit_log_entity",
        "audit_log",
        ["entity_type", "entity_id"],
        postgresql_where=sa.text("entity_id IS NOT NULL"),
    )

    # ── message.sent_by_user_id: human send attribution ──────────────
    op.add_column(
        "message",
        sa.Column(
            "sent_by_user_id",
            sa.Integer,
            sa.ForeignKey("admin_user.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("message", "sent_by_user_id")
    op.drop_index("ix_audit_log_entity", table_name="audit_log")
    op.drop_index("ix_audit_log_at", table_name="audit_log")
    op.drop_table("audit_log")
    op.drop_index("ix_user_casa_user", table_name="user_casa")
    op.drop_table("user_casa")
    op.drop_constraint("ck_admin_user_role", "admin_user", type_="check")
    op.drop_column("admin_user", "active")
    op.drop_column("admin_user", "role")
    op.drop_column("admin_user", "name")
