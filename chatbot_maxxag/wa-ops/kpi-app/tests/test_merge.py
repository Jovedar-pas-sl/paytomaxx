"""Hardened same-client merge: queries.merge_conversation_into (reversible, phone-
preserving, same-line) + the deterministic structural gate find_structural_merge_
sibling. The same-id guard runs without a DB; the rest need pg_pool (skipped without
TEST_DATABASE_URL)."""
from __future__ import annotations

import pytest

from app import queries


async def _mk_conv(pool, casa_id, wa_number_id, jid, *, phone=None, unread=0):
    contact = await pool.fetchval(
        "INSERT INTO contact (waha_jid, phone) VALUES ($1,$2) RETURNING id", jid, phone
    )
    conv = await pool.fetchval(
        "INSERT INTO conversation (casa_id, wa_number_id, contact_id, unread_count, last_message_at) "
        "VALUES ($1,$2,$3,$4, now()) RETURNING id",
        casa_id, wa_number_id, contact, unread,
    )
    return conv, contact


async def _msg(pool, conv, direction, body):
    await pool.execute(
        "INSERT INTO message (conversation_id, direction, body, created_at) "
        "VALUES ($1,$2,$3, now())",
        conv, direction, body,
    )


async def test_merge_same_id_raises() -> None:
    with pytest.raises(ValueError, match="same id"):
        await queries.merge_conversation_into(None, 7, 7)  # type: ignore[arg-type]


async def test_merge_moves_messages_and_records_undo(pg_pool) -> None:
    casa = await pg_pool.fetchval("INSERT INTO casa (name, waha_session) VALUES ('C','s1') RETURNING id")
    src, c_src = await _mk_conv(pg_pool, casa, 1, "111@lid", unread=2)
    tgt, c_tgt = await _mk_conv(pg_pool, casa, 1, "34111@c.us", phone="34111", unread=1)
    await _msg(pg_pool, src, "in", "hola")
    await _msg(pg_pool, tgt, "out", "buenas")

    await queries.merge_conversation_into(pg_pool, src, tgt, triggered_by="auto", confidence=0.9)

    # Source gone; both messages on target, the moved one tagged for undo.
    assert await pg_pool.fetchval("SELECT count(*) FROM conversation WHERE id=$1", src) == 0
    assert await pg_pool.fetchval("SELECT count(*) FROM message WHERE conversation_id=$1", tgt) == 2
    assert await pg_pool.fetchval(
        "SELECT count(*) FROM message WHERE conversation_id=$1 AND merged_from_conv_id=$2", tgt, src
    ) == 1
    # Orphan source contact deleted; unread combined.
    assert await pg_pool.fetchval("SELECT count(*) FROM contact WHERE id=$1", c_src) == 0
    assert await pg_pool.fetchval("SELECT unread_count FROM conversation WHERE id=$1", tgt) == 3
    # Reversible: a merge_event snapshot was written.
    ev = await pg_pool.fetchrow(
        "SELECT source_conv_id, target_conv_id, triggered_by, messages_moved, "
        "source_contact_snapshot FROM merge_event WHERE source_conv_id=$1", src
    )
    assert ev is not None
    assert ev["target_conv_id"] == tgt and ev["triggered_by"] == "auto" and ev["messages_moved"] == 1
    snap = ev["source_contact_snapshot"]
    if isinstance(snap, str):  # asyncpg returns JSONB as text without a codec
        import json as _json
        snap = _json.loads(snap)
    assert snap["waha_jid"] == "111@lid"


async def test_merge_preserves_phone_on_survivor(pg_pool) -> None:
    # Source holds the real number (@c.us), target is the @lid with none → survivor
    # must KEEP the phone.
    casa = await pg_pool.fetchval("INSERT INTO casa (name, waha_session) VALUES ('C','s2') RETURNING id")
    src, _ = await _mk_conv(pg_pool, casa, 1, "34222@c.us", phone="34222")
    tgt, c_tgt = await _mk_conv(pg_pool, casa, 1, "222@lid", phone=None)
    await _msg(pg_pool, src, "in", "hey")

    await queries.merge_conversation_into(pg_pool, src, tgt, triggered_by="manual")

    assert await pg_pool.fetchval("SELECT phone FROM contact WHERE id=$1", c_tgt) == "34222"


async def test_merge_different_casas_raises(pg_pool) -> None:
    ca = await pg_pool.fetchval("INSERT INTO casa (name, waha_session) VALUES ('A','sa') RETURNING id")
    cb = await pg_pool.fetchval("INSERT INTO casa (name, waha_session) VALUES ('B','sb') RETURNING id")
    s, _ = await _mk_conv(pg_pool, ca, 1, "a@c.us")
    t, _ = await _mk_conv(pg_pool, cb, 1, "b@c.us")
    with pytest.raises(ValueError, match="different casas"):
        await queries.merge_conversation_into(pg_pool, s, t, triggered_by="manual")


async def test_merge_different_lines_raises_by_default(pg_pool) -> None:
    # Auto path (allow_cross_line=False) must never cross WhatsApp lines.
    casa = await pg_pool.fetchval("INSERT INTO casa (name, waha_session) VALUES ('C','sc') RETURNING id")
    s, _ = await _mk_conv(pg_pool, casa, 1, "x@c.us")
    t, _ = await _mk_conv(pg_pool, casa, 2, "y@lid")  # different wa_number_id
    with pytest.raises(ValueError, match="different lines"):
        await queries.merge_conversation_into(pg_pool, s, t, triggered_by="auto")


async def test_merge_cross_line_allowed_for_human(pg_pool) -> None:
    # A human-triggered merge (manual/ia button) MAY join two lines of the same casa.
    casa = await pg_pool.fetchval("INSERT INTO casa (name, waha_session) VALUES ('C','scl') RETURNING id")
    s, c_s = await _mk_conv(pg_pool, casa, 1, "xx@c.us")
    t, _ = await _mk_conv(pg_pool, casa, 2, "yy@lid")
    await _msg(pg_pool, s, "in", "hola")
    await queries.merge_conversation_into(
        pg_pool, s, t, triggered_by="manual", allow_cross_line=True
    )
    assert await pg_pool.fetchval("SELECT count(*) FROM conversation WHERE id=$1", s) == 0
    assert await pg_pool.fetchval("SELECT count(*) FROM contact WHERE id=$1", c_s) == 0


async def test_merge_missing_conversation_raises(pg_pool) -> None:
    with pytest.raises(ValueError, match="not found"):
        await queries.merge_conversation_into(pg_pool, 999001, 999002, triggered_by="auto")


async def test_structural_sibling_found_and_ambiguity_rejected(pg_pool) -> None:
    casa = await pg_pool.fetchval("INSERT INTO casa (name, waha_session) VALUES ('C','ss') RETURNING id")
    # Source: incoming-only (@lid). Sibling: outgoing-only (@c.us), SAME line.
    src, _ = await _mk_conv(pg_pool, casa, 1, "333@lid")
    sib, _ = await _mk_conv(pg_pool, casa, 1, "34333@c.us")
    await _msg(pg_pool, src, "in", "hola")
    await _msg(pg_pool, sib, "out", "buenas")
    assert await queries.find_structural_merge_sibling(pg_pool, src) == sib

    # A second outgoing-only sibling on the same line → ambiguous → None.
    sib2, _ = await _mk_conv(pg_pool, casa, 1, "34999@c.us")
    await _msg(pg_pool, sib2, "out", "hey")
    assert await queries.find_structural_merge_sibling(pg_pool, src) is None

    # A sibling on a DIFFERENT line is not a candidate.
    casa2 = await pg_pool.fetchval("INSERT INTO casa (name, waha_session) VALUES ('D','sd') RETURNING id")
    only, _ = await _mk_conv(pg_pool, casa2, 5, "444@lid")
    await _msg(pg_pool, only, "in", "hola")
    other, _ = await _mk_conv(pg_pool, casa2, 6, "34444@c.us")  # different wa_number_id
    await _msg(pg_pool, other, "out", "buenas")
    assert await queries.find_structural_merge_sibling(pg_pool, only) is None
