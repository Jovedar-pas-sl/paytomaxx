"""Same-client detection for conversation dedup / auto-merge.

A client can reach a casa under TWO WhatsApp JIDs — @c.us (their number, used when
WE text them) and @lid (privacy id, used when THEY text us) — producing two
contacts and two one-sided conversations. This asks Claude which recent sibling
conversation is the same person, so the caller can merge them.

Shared by BOTH the manual `/conversation/{id}/auto-merge` button and the worker's
auto-merge sweep, so both apply the exact same IA logic — only the confidence
threshold differs (the button is lenient at 0.7; the unattended sweep is strict at
0.85 so it never merges two different clients).
"""
from __future__ import annotations

import asyncpg

from app import queries
from app.analyzer.skills import Message, SiblingConvo, detect_same_client
from app.models import MergeDetectResult


async def find_same_client_target(
    kpi: asyncpg.Pool, conversation_id: int
) -> MergeDetectResult | None:
    """Ask Claude which recent sibling (same casa, last 24h) is the SAME client as
    `conversation_id`. Returns the MergeDetectResult (best_match_id + confidence +
    reasoning), or None when the conversation is gone or has no candidate siblings
    (no Claude call is made in that case). The CALLER applies the confidence gate.
    May raise on a Claude/API error — callers handle it."""
    detail = await queries.get_conversation_detail(kpi, conversation_id)
    if not detail:
        return None

    async with kpi.acquire() as conn:
        target_rows = await conn.fetch(
            "SELECT body, direction, extract(epoch from created_at)::int AS ts "
            "FROM message WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 25",
            conversation_id,
        )
        sibling_rows = await conn.fetch(
            """
            SELECT c.id, ct.name, ct.phone, ct.waha_jid
            FROM conversation c
            JOIN contact ct ON ct.id = c.contact_id
            WHERE c.casa_id = $1 AND c.id != $2
              AND c.last_message_at > now() - interval '24 hours'
            ORDER BY c.last_message_at DESC LIMIT 8
            """,
            detail.casa_id, conversation_id,
        )
        siblings: list[SiblingConvo] = []
        for s in sibling_rows:
            s_msgs = await conn.fetch(
                "SELECT body, direction, extract(epoch from created_at)::int AS ts "
                "FROM message WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 15",
                s["id"],
            )
            label = s["name"] or s["phone"] or (s["waha_jid"][:24] + "…")
            siblings.append(SiblingConvo(
                conv_id=s["id"],
                label=label,
                messages=[
                    Message(
                        ts=r["ts"],
                        role="cliente" if r["direction"] == "in" else "mamai",
                        content=(r["body"] or "")[:200],
                    )
                    for r in s_msgs
                ],
            ))

    if not siblings:
        return None

    target_label = detail.contact_name or detail.contact_phone or "target"
    target_msgs = [
        Message(
            ts=r["ts"],
            role="cliente" if r["direction"] == "in" else "mamai",
            content=(r["body"] or "")[:200],
        )
        for r in target_rows
    ]
    result = await detect_same_client(target_msgs, target_label, siblings)
    # Defense-in-depth: never act on an LLM-returned id that was NOT a presented
    # candidate (a hallucinated real id could otherwise slip past the merge guards).
    if result.best_match_id is not None and result.best_match_id not in {s.conv_id for s in siblings}:
        return result.model_copy(update={"best_match_id": None})
    return result


async def confirm_same_client(
    kpi: asyncpg.Pool, source_id: int, sibling_id: int
) -> MergeDetectResult | None:
    """Ask Claude to CONFIRM that ONE specific `sibling_id` is the same client as
    `source_id`. Used by the unattended sweep AFTER the deterministic structural gate
    (queries.find_structural_merge_sibling) already picked the single candidate, so
    the model only ever votes yes/no on that pair — it can't wander to an unrelated
    conversation. The caller checks best_match_id == sibling_id AND the high-conf
    gate. Returns None if either conversation is gone. May raise on a Claude error."""
    detail = await queries.get_conversation_detail(kpi, source_id)
    if not detail:
        return None

    async with kpi.acquire() as conn:
        target_rows = await conn.fetch(
            "SELECT body, direction, extract(epoch from created_at)::int AS ts "
            "FROM message WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 25",
            source_id,
        )
        sib = await conn.fetchrow(
            "SELECT c.id, ct.name, ct.phone, ct.waha_jid "
            "FROM conversation c JOIN contact ct ON ct.id = c.contact_id WHERE c.id = $1",
            sibling_id,
        )
        if not sib:
            return None
        s_msgs = await conn.fetch(
            "SELECT body, direction, extract(epoch from created_at)::int AS ts "
            "FROM message WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 15",
            sibling_id,
        )

    siblings = [SiblingConvo(
        conv_id=sib["id"],
        label=sib["name"] or sib["phone"] or (sib["waha_jid"][:24] + "…"),
        messages=[
            Message(
                ts=r["ts"],
                role="cliente" if r["direction"] == "in" else "mamai",
                content=(r["body"] or "")[:200],
            )
            for r in s_msgs
        ],
    )]
    target_msgs = [
        Message(
            ts=r["ts"],
            role="cliente" if r["direction"] == "in" else "mamai",
            content=(r["body"] or "")[:200],
        )
        for r in target_rows
    ]
    target_label = detail.contact_name or detail.contact_phone or "target"
    result = await detect_same_client(target_msgs, target_label, siblings)
    # Defense-in-depth: never act on an LLM-returned id that was NOT a presented
    # candidate (a hallucinated real id could otherwise slip past the merge guards).
    if result.best_match_id is not None and result.best_match_id not in {s.conv_id for s in siblings}:
        return result.model_copy(update={"best_match_id": None})
    return result
