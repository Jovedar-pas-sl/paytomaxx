#!/usr/bin/env python3
"""One-off: set each casa's reception WhatsApp number (casa_profile.whatsapp_recepcion).

This is the number that receives the encargada heads-ups: verify a named girl,
confirm a proposed hour, and the booking-close alert. Casas are matched by NAME
keyword (valencia / madrid / marbella / ibiza / ...), so ids never have to be
hard-coded. Idempotent — re-running just re-sets the values.

The website sync (every 20 min) treats whatsapp_recepcion as OWNER-CURATED (see
queries.upsert_casa_profile_from_sync): it only seeds the number when the DB is
empty and never overrides a value set here, so what you set survives.

Usage (inside the kpi-app container; DATABASE_URL comes from the env):
    python set_recepcion.py valencia=+34600111222 madrid=+34600111333 \
        marbella=+34600111444 ibiza=+34600111555
    python set_recepcion.py --dry-run valencia=+34600111222   # preview, no write
"""
from __future__ import annotations

import argparse
import asyncio
import os
import re
import sys

import asyncpg


def _dsn_from_env() -> str:
    """Read DATABASE_URL and strip any SQLAlchemy '+driver' suffix for asyncpg."""
    raw = os.environ.get("DATABASE_URL")
    if not raw:
        sys.exit("DATABASE_URL not set in the environment")
    return re.sub(r"^postgresql\+\w+://", "postgresql://", raw)


def _normalize_phone(raw: str) -> str:
    """Keep a leading '+' and ASCII digits only ('+34 621 033 316' -> '+34621033316').

    Uses an explicit 0-9 filter (not str.isdigit(), which also accepts superscripts
    and other Unicode digits) so a pasted number can't silently normalize to junk."""
    digits = "".join(ch for ch in raw if ch in "0123456789")
    return ("+" + digits) if raw.strip().startswith("+") else digits


def _parse_pairs(pairs: list[str]) -> dict[str, str]:
    """Parse `keyword=phone` args into {keyword: normalized_phone}, validating each."""
    out: dict[str, str] = {}
    for pair in pairs:
        if "=" not in pair:
            sys.exit(f"bad arg {pair!r} — expected keyword=phone, e.g. valencia=+34600111222")
        key, _, val = pair.partition("=")
        key = key.strip().lower()
        phone = _normalize_phone(val)
        if not key or len(phone.lstrip("+")) < 9:
            sys.exit(f"bad pair {pair!r} — empty keyword or too-short phone")
        out[key] = phone
    return out


async def run(numbers: dict[str, str], apply: bool) -> None:
    conn = await asyncpg.connect(_dsn_from_env())
    try:
        for keyword, phone in numbers.items():
            rows = await conn.fetch(
                "SELECT id, name FROM casa WHERE name ILIKE $1", f"%{keyword}%"
            )
            if not rows:
                print(f"{keyword}: NO CASA matched — skipped")
                continue
            if len(rows) > 1:
                print(
                    f"{keyword}: ⚠ matched {len(rows)} casas — applying to ALL "
                    "(use a more specific keyword if that's not intended)"
                )
            for r in rows:
                tag = "" if apply else " [DRY RUN]"
                print(f"{keyword}: casa {r['id']} ({r['name']}) -> whatsapp_recepcion={phone}{tag}")
                if apply:
                    status = await conn.execute(
                        """
                        UPDATE casa_profile
                        SET whatsapp_recepcion = $2, updated_at = now()
                        WHERE casa_id = $1
                        """,
                        r["id"],
                        phone,
                    )
                    if status.endswith(" 0"):
                        print(f"  ⚠ casa {r['id']} has no casa_profile row yet — not set")
    finally:
        await conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Set casa reception WhatsApp numbers.")
    parser.add_argument("pairs", nargs="+", help="keyword=phone, e.g. valencia=+34600111222")
    parser.add_argument("--dry-run", action="store_true", help="preview, do not write")
    args = parser.parse_args()
    numbers = _parse_pairs(args.pairs)
    asyncio.run(run(numbers, apply=not args.dry_run))
    print("done." if not args.dry_run else "dry run — re-run without --dry-run to apply")


if __name__ == "__main__":
    main()
