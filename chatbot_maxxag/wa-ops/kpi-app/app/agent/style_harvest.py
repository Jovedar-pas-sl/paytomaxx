"""Harvest real human-receptionist replies into style-example candidates.

Pure helpers + one async harvest-per-casa coroutine, kept out of worker.py so the
sanitization/classification logic is unit-testable without arq. The daily cron
(`harvest_style_examples_job` in app.analyzer.worker) calls `harvest_casa` for
each casa; a super-admin then approves candidates under /ajustes/estilo, and
`reply_engine` injects the APPROVED ones as style guidance.

PII discipline: receptionist replies can contain phone numbers / links the human
typed. `scrub` strips tags, control chars, URLs and phone-like digit runs before
anything is stored — the address is deliberately NOT a target here (it rarely
appears in a short reply, and the prompt already withholds it by design), but the
super-admin still reviews every candidate before it can reach Sara.
"""

from __future__ import annotations

import logging
import os
import re
from collections import Counter
from dataclasses import dataclass

import asyncpg

from app import queries
from app.agent import lang_detect

logger = logging.getLogger("agent.style_harvest")

# Reuse the harvest/length tunables defined alongside the SQL (single source).
_REPLY_MIN = queries._STYLE_REPLY_MIN_LEN
_REPLY_MAX = queries._STYLE_REPLY_MAX_LEN
_CLIENT_MAX = 200
# Max NEW candidates inserted per casa per run, so one busy casa never floods the
# review queue in a single night.
_MAX_NEW_PER_CASA = 40


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


# AUTO-LEARN: a reply the encargada REPEATS at least this many times (deduped by
# pattern, within the 30-day harvest window) is trusted enough to approve on its
# own — the bot learns what the team says consistently, no manual review. One-offs
# stay 'pending'. Env-tunable; set to 0 to disable auto-approval (old behavior).
_AUTO_APPROVE_MIN = _env_int("STYLE_AUTO_APPROVE_MIN", 3)
# Fetch more replies than we insert so the frequency count ("what repeats") is
# meaningful — not just the last handful.
_HARVEST_FETCH = 600

_TAG_RE = re.compile(r"<[^>]*>")
_CTRL_RE = re.compile(r"[\x00-\x1F]")
_URL_RE = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)
# Phone-ish: an optional '+' then 8+ digits, allowing spaces / () . - between.
_PHONE_RE = re.compile(r"\+?\d[\d\s().\-]{6,}\d")
_WS_RE = re.compile(r"\s+")


def scrub(text: str, maxlen: int) -> str:
    """Strip tags, URLs, phone-like runs and control chars; collapse whitespace;
    truncate. Used for BOTH the reply and the client message before storage."""
    if not text:
        return ""
    t = _TAG_RE.sub(" ", text)
    t = _URL_RE.sub(" ", t)
    t = _PHONE_RE.sub(" ", t)
    t = _CTRL_RE.sub(" ", t)
    t = _WS_RE.sub(" ", t).strip()
    return t[:maxlen]


def dedup_key(reply: str) -> str:
    """Stable key for a reply: accent-folded, lowercased, whitespace-collapsed,
    truncated. Two replies that differ only in accents/case/spacing dedup to one."""
    folded = lang_detect._fold(reply)
    return _WS_RE.sub(" ", folded).strip()[:160]


@dataclass(frozen=True)
class Candidate:
    """A sanitized style-example candidate ready to insert as 'pending'."""
    lang: str | None
    kind: str  # 'pair' (has client_msg) | 'phrase'
    client_msg: str | None
    reply_msg: str
    dedup_key: str


def build_candidate(h: queries.HarvestedReply) -> Candidate | None:
    """Turn a raw harvested reply into a sanitized Candidate, or None if it is not
    a useful style example (out of length bounds, or scrubbed to nothing)."""
    raw = (h.reply_msg or "").strip()
    # Reject before scrubbing on the ORIGINAL length so a long operational blob
    # is dropped rather than silently truncated into a misleading example.
    if not (_REPLY_MIN <= len(raw) <= _REPLY_MAX):
        return None
    reply = scrub(raw, _REPLY_MAX)
    if len(reply) < _REPLY_MIN:
        return None
    client = scrub(h.client_msg or "", _CLIENT_MAX) if h.client_msg else ""
    kind = "pair" if client else "phrase"
    lang = lang_detect.detect_lang(reply)
    if lang is None and client:
        lang = lang_detect.detect_lang(client)
    key = dedup_key(reply)
    if not key:
        return None
    return Candidate(
        lang=lang, kind=kind, client_msg=(client or None), reply_msg=reply, dedup_key=key
    )


async def harvest_casa(kpi: asyncpg.Pool, casa_id: int) -> int:
    """Harvest one casa: fetch recent human replies, build sanitized candidates and
    UPSERT them. A reply REPEATED >= _AUTO_APPROVE_MIN times (deduped by pattern)
    goes in — or gets an existing 'pending' promoted — as 'approved', so the bot
    learns what the encargada says consistently WITHOUT manual review; one-offs stay
    'pending'. Returns the count of NEW rows inserted (the caller sums it)."""
    rows = await queries.fetch_human_replies_for_harvest(kpi, casa_id, limit=_HARVEST_FETCH)
    # Frequency per reply PATTERN = "lo que se repite". Keep the first occurrence as
    # the representative candidate (its client_msg pairs the recurring reply).
    freq: Counter[str] = Counter()
    rep: dict[str, Candidate] = {}
    for h in rows:
        cand = build_candidate(h)
        if cand is None:
            continue
        freq[cand.dedup_key] += 1
        rep.setdefault(cand.dedup_key, cand)

    inserted = 0
    auto_approved = 0
    for key, cand in rep.items():
        auto = _AUTO_APPROVE_MIN > 0 and freq[key] >= _AUTO_APPROVE_MIN
        ok = await queries.insert_style_example(
            kpi,
            casa_id=casa_id,
            lang=cand.lang,
            kind=cand.kind,
            client_msg=cand.client_msg,
            reply_msg=cand.reply_msg,
            dedup_key=cand.dedup_key,
            source="cron",
            status="approved" if auto else "pending",
        )
        if ok:
            inserted += 1
            if auto:
                auto_approved += 1
        if inserted >= _MAX_NEW_PER_CASA:
            break
    logger.info(
        "style_harvest: casa=%s new=%s auto_approved=%s (>=%s repeats)",
        casa_id, inserted, auto_approved, _AUTO_APPROVE_MIN,
    )
    return inserted
