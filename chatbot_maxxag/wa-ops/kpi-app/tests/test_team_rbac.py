"""Fase 1 — multi-user RBAC + audit.

Two layers:
  * Unit (no DB): model role helpers, password hashing, the require_roles
    guard, and the email validator. Always run.
  * DB-backed (pg_pool fixture): user CRUD, casa assignment, bootstrap
    idempotency, and the audit feed. Skip without TEST_DATABASE_URL.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app import team
from app.auth import hash_password, verify_password
from app.deps import require_roles
from app.models import AdminUser
from app.routes.settings_routes import _valid_email


# ── Unit: model role helpers ─────────────────────────────────────────
def test_role_helpers() -> None:
    su = AdminUser(email="a@b.com", role="super_admin")
    ad = AdminUser(email="a@b.com", role="admin")
    ag = AdminUser(email="a@b.com", role="agent", name="Ana")

    assert su.is_super_admin and su.is_admin
    assert not ad.is_super_admin and ad.is_admin
    assert not ag.is_super_admin and not ag.is_admin


def test_display_name_prefers_name_then_email() -> None:
    assert AdminUser(email="a@b.com", name="Ana").display_name == "Ana"
    assert AdminUser(email="a@b.com").display_name == "a@b.com"
    assert AdminUser(email="a@b.com", name="").display_name == "a@b.com"


# ── Unit: password hashing ───────────────────────────────────────────
def test_password_roundtrip() -> None:
    h = hash_password("una-clave-larga")
    assert h != "una-clave-larga"  # actually hashed
    assert verify_password("una-clave-larga", h)
    assert not verify_password("otra", h)


# ── Unit: email validator ────────────────────────────────────────────
@pytest.mark.parametrize(
    "email,ok",
    [
        ("persona@maxxag.com", True),
        ("x@y.co", True),
        ("nope", False),
        ("a@b", False),          # no dot in domain
        ("@b.com", True),        # technically passes the loose check (has @ and dotted domain)
        ("", False),
    ],
)
def test_valid_email(email: str, ok: bool) -> None:
    assert _valid_email(email) is ok


# ── Unit: require_roles guard ────────────────────────────────────────
async def test_require_roles_allows_listed_role() -> None:
    dep = require_roles("admin", "super_admin")
    su = AdminUser(email="a@b.com", role="super_admin")
    assert await dep(user=su) is su


async def test_require_roles_blocks_other_roles() -> None:
    dep = require_roles("admin", "super_admin")
    agent = AdminUser(email="a@b.com", role="agent")
    with pytest.raises(HTTPException) as exc:
        await dep(user=agent)
    assert exc.value.status_code == 403


# ── DB-backed: user CRUD ─────────────────────────────────────────────
async def test_create_and_fetch_user(pg_pool) -> None:
    u = await team.create_user(
        pg_pool, email="Ana@X.com", name="Ana", role="agent",
        password_hash=hash_password("clave-12345"),
    )
    assert u.id is not None
    assert u.email == "ana@x.com"   # normalized
    assert u.role == "agent" and u.active

    by_email = await team.get_user_by_email(pg_pool, "ana@x.com")
    assert by_email is not None and by_email.id == u.id

    row = await team.get_login_row(pg_pool, "ana@x.com")
    assert row is not None and verify_password("clave-12345", row["password_hash"])


async def test_set_active_and_role(pg_pool) -> None:
    u = await team.create_user(
        pg_pool, email="b@x.com", name="B", role="agent",
        password_hash=hash_password("clave-12345"),
    )
    await team.set_active(pg_pool, u.id, False)
    assert (await team.get_user_by_id(pg_pool, u.id)).active is False

    await team.set_role(pg_pool, u.id, "admin")
    assert (await team.get_user_by_id(pg_pool, u.id)).role == "admin"


async def test_casa_assignment_roundtrip(pg_pool) -> None:
    casa_id = await pg_pool.fetchval(
        "INSERT INTO casa (name, waha_session) VALUES ('Casa1', 's1') RETURNING id"
    )
    u = await team.create_user(
        pg_pool, email="c@x.com", name="C", role="agent",
        password_hash=hash_password("clave-12345"),
    )
    await team.set_casa_assignments(pg_pool, u.id, [casa_id])
    assert await team.get_assigned_casa_ids(pg_pool, u.id) == [casa_id]
    assert (await team.get_all_casa_assignments(pg_pool))[u.id] == [casa_id]

    # Empty assignment == sees all (no rows).
    await team.set_casa_assignments(pg_pool, u.id, [])
    assert await team.get_assigned_casa_ids(pg_pool, u.id) == []


# ── DB-backed: bootstrap + audit ─────────────────────────────────────
async def test_bootstrap_super_admin_is_idempotent(pg_pool) -> None:
    await team.ensure_bootstrap_super_admin(
        pg_pool, email="owner@x.com", password_hash=hash_password("clave-12345")
    )
    owner = await team.get_user_by_email(pg_pool, "owner@x.com")
    assert owner is not None and owner.role == "super_admin" and owner.active

    # Second run must not duplicate the row nor change the password hash.
    await team.ensure_bootstrap_super_admin(
        pg_pool, email="owner@x.com", password_hash="ignored-on-existing"
    )
    assert len([u for u in await team.list_users(pg_pool) if u.email == "owner@x.com"]) == 1
    row = await team.get_login_row(pg_pool, "owner@x.com")
    assert verify_password("clave-12345", row["password_hash"])  # original kept


async def test_audit_insert_and_feed(pg_pool) -> None:
    owner = await team.create_user(
        pg_pool, email="o@x.com", name="Owner", role="super_admin",
        password_hash=hash_password("clave-12345"),
    )
    await team.audit(
        pg_pool, action="login", actor_label=owner.display_name, user_id=owner.id,
    )
    await team.audit(
        pg_pool, action="user_create", actor_label=owner.display_name,
        user_id=owner.id, entity_type="user", entity_id=999, meta={"email": "new@x.com"},
    )
    feed = await team.list_recent_audit(pg_pool, limit=10)
    assert len(feed) == 2
    assert feed[0]["action"] == "user_create"   # newest first
    assert feed[1]["action"] == "login"
