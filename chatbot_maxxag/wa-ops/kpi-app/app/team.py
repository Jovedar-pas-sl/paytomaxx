"""Team / RBAC data access: users, casa assignment, audit log.

Raw asyncpg against the `admin_user` / `user_casa` / `audit_log` tables
(migration 0018). Kept separate from `queries.py` (analytics SQL) for cohesion.

Roles: super_admin (manages users, sees/configures all) · admin (casas,
conversations, informes) · agent (answers conversations; can be scoped to
specific casas via user_casa).
"""
from __future__ import annotations

import json
from typing import Any

import asyncpg

from app.models import AdminUser, Role

# Columns that build an AdminUser (never select password_hash into the model).
_USER_COLS = "id, email, name, role, active"


def _row_to_user(row: asyncpg.Record) -> AdminUser:
    return AdminUser(
        id=row["id"],
        email=row["email"],
        name=row["name"],
        role=row["role"],
        active=row["active"],
    )


# ── Lookups ──────────────────────────────────────────────────────────
async def get_user_by_id(db: asyncpg.Pool, user_id: int) -> AdminUser | None:
    row = await db.fetchrow(
        f"SELECT {_USER_COLS} FROM admin_user WHERE id = $1", user_id
    )
    return _row_to_user(row) if row else None


async def get_user_by_email(db: asyncpg.Pool, email: str) -> AdminUser | None:
    row = await db.fetchrow(
        f"SELECT {_USER_COLS} FROM admin_user WHERE email = $1", email.strip().lower()
    )
    return _row_to_user(row) if row else None


async def get_login_row(db: asyncpg.Pool, email: str) -> asyncpg.Record | None:
    """Fetch the row needed to authenticate a login (includes password_hash)."""
    return await db.fetchrow(
        f"SELECT {_USER_COLS}, password_hash FROM admin_user WHERE email = $1",
        email.strip().lower(),
    )


async def list_users(db: asyncpg.Pool) -> list[AdminUser]:
    rows = await db.fetch(
        f"SELECT {_USER_COLS} FROM admin_user ORDER BY active DESC, role, email"
    )
    return [_row_to_user(r) for r in rows]


# ── Mutations ────────────────────────────────────────────────────────
async def create_user(
    db: asyncpg.Pool,
    *,
    email: str,
    name: str | None,
    role: Role,
    password_hash: str,
) -> AdminUser:
    row = await db.fetchrow(
        f"""
        INSERT INTO admin_user (email, name, role, password_hash, active)
        VALUES ($1, $2, $3, $4, true)
        RETURNING {_USER_COLS}
        """,
        email.strip().lower(),
        (name or "").strip() or None,
        role,
        password_hash,
    )
    return _row_to_user(row)


async def set_active(db: asyncpg.Pool, user_id: int, active: bool) -> None:
    await db.execute(
        "UPDATE admin_user SET active = $2 WHERE id = $1", user_id, active
    )


async def set_role(db: asyncpg.Pool, user_id: int, role: Role) -> None:
    await db.execute("UPDATE admin_user SET role = $2 WHERE id = $1", user_id, role)


async def set_password(db: asyncpg.Pool, user_id: int, password_hash: str) -> None:
    await db.execute(
        "UPDATE admin_user SET password_hash = $2 WHERE id = $1", user_id, password_hash
    )


async def touch_last_login(db: asyncpg.Pool, user_id: int) -> None:
    await db.execute(
        "UPDATE admin_user SET last_login_at = now() WHERE id = $1", user_id
    )


# ── Casa assignment (agent scope) ────────────────────────────────────
async def get_assigned_casa_ids(db: asyncpg.Pool, user_id: int) -> list[int]:
    rows = await db.fetch(
        "SELECT casa_id FROM user_casa WHERE user_id = $1 ORDER BY casa_id", user_id
    )
    return [r["casa_id"] for r in rows]


async def get_all_casa_assignments(db: asyncpg.Pool) -> dict[int, list[int]]:
    """Map every user_id → its assigned casa_ids (for the Ajustes table)."""
    rows = await db.fetch("SELECT user_id, casa_id FROM user_casa ORDER BY user_id, casa_id")
    out: dict[int, list[int]] = {}
    for r in rows:
        out.setdefault(r["user_id"], []).append(r["casa_id"])
    return out


async def set_casa_assignments(
    db: asyncpg.Pool, user_id: int, casa_ids: list[int]
) -> None:
    """Replace the user's casa assignments with `casa_ids` (atomic)."""
    async with db.acquire() as conn, conn.transaction():
        await conn.execute("DELETE FROM user_casa WHERE user_id = $1", user_id)
        if casa_ids:
            await conn.executemany(
                "INSERT INTO user_casa (user_id, casa_id) VALUES ($1, $2)",
                [(user_id, cid) for cid in casa_ids],
            )


# ── Bootstrap ────────────────────────────────────────────────────────
async def ensure_bootstrap_super_admin(
    db: asyncpg.Pool, *, email: str, password_hash: str
) -> None:
    """Guarantee the env admin exists in admin_user as an active super_admin.

    Run on startup. Idempotent. On first boot it inserts the row with the env
    password hash; thereafter it only enforces role/active so a password the
    owner sets in-app is NOT overwritten on every restart.
    """
    email = email.strip().lower()
    row = await db.fetchrow("SELECT id FROM admin_user WHERE email = $1", email)
    if row is None:
        await db.execute(
            """
            INSERT INTO admin_user (email, name, role, password_hash, active)
            VALUES ($1, 'Owner', 'super_admin', $2, true)
            """,
            email,
            password_hash,
        )
    else:
        await db.execute(
            "UPDATE admin_user SET role = 'super_admin', active = true WHERE id = $1",
            row["id"],
        )


# ── Audit log ────────────────────────────────────────────────────────
async def audit(
    db: asyncpg.Pool,
    *,
    action: str,
    actor_label: str,
    user_id: int | None = None,
    entity_type: str | None = None,
    entity_id: int | None = None,
    meta: dict[str, Any] | None = None,
) -> None:
    """Append one lean audit entry. Never raises into the caller's flow."""
    try:
        await db.execute(
            """
            INSERT INTO audit_log (user_id, actor_label, action, entity_type, entity_id, meta)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb)
            """,
            user_id,
            actor_label,
            action,
            entity_type,
            entity_id,
            json.dumps(meta) if meta is not None else None,
        )
    except Exception:  # noqa: BLE001 — auditing must never break the action it logs
        pass


async def list_recent_audit(db: asyncpg.Pool, *, limit: int = 50) -> list[asyncpg.Record]:
    """Most recent audit entries (newest first) for the team activity feed."""
    return await db.fetch(
        """
        SELECT al.at, al.actor_label, al.action, al.entity_type, al.entity_id, al.meta,
               u.name AS user_name, u.email AS user_email
        FROM audit_log al
        LEFT JOIN admin_user u ON u.id = al.user_id
        ORDER BY al.at DESC
        LIMIT $1
        """,
        limit,
    )
