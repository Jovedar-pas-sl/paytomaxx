#!/usr/bin/env python3
"""One-off: set each casa's OUTCALL base price (casa_profile.outcall.base_price_eur).

F3 prices an outcall as `base_price_eur + taxi * 1.20` (rounded up to 10€). The
base is auto-parsed from the synced web rate ("a hotel/domicilio") when that rate
is numeric; for casas whose web says "consultar" (Madrid, Marbella, Ibiza) the
owner sets it here. This MERGES base_price_eur into the casa_profile.outcall JSONB
with `||`, so any other curated keys (e.g. taxi_surcharge_pct) are preserved.

Casas are matched by NAME keyword (madrid / marbella / ibiza / vlc / ...), so ids
never have to be hard-coded. Idempotent — re-running just re-sets the values.

Usage (inside the kpi-app container; DATABASE_URL comes from the env):
    python set_outcall_base.py madrid=180 marbella=280 ibiza=250
    python set_outcall_base.py --dry-run madrid=180        # preview, no write
"""
from __future__ import annotations

import argparse
import asyncio
import json
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


def _parse_pairs(pairs: list[str]) -> dict[str, float]:
    """Parse `keyword=price` args into {keyword: price}, validating each."""
    out: dict[str, float] = {}
    for pair in pairs:
        if "=" not in pair:
            sys.exit(f"bad arg {pair!r} — expected keyword=price, e.g. madrid=180")
        key, _, val = pair.partition("=")
        key = key.strip().lower()
        try:
            price = float(val)
        except ValueError:
            sys.exit(f"bad price in {pair!r} — not a number")
        if not key or price <= 0:
            sys.exit(f"bad pair {pair!r} — empty keyword or price <= 0")
        out[key] = price
    return out


async def run(bases: dict[str, float], apply: bool) -> None:
    conn = await asyncpg.connect(_dsn_from_env())
    try:
        for keyword, price in bases.items():
            rows = await conn.fetch(
                "SELECT id, name FROM casa WHERE name ILIKE $1", f"%{keyword}%"
            )
            if not rows:
                print(f"{keyword}: NO CASA matched — skipped")
                continue
            for r in rows:
                tag = "" if apply else " [DRY RUN]"
                print(f"{keyword}: casa {r['id']} ({r['name']}) -> base_price_eur={price:g}{tag}")
                if apply:
                    await conn.execute(
                        """
                        UPDATE casa_profile
                        SET outcall = coalesce(outcall, '{}'::jsonb) || $2::jsonb
                        WHERE casa_id = $1
                        """,
                        r["id"],
                        json.dumps({"base_price_eur": price}),
                    )
    finally:
        await conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Set casa outcall base prices.")
    parser.add_argument("pairs", nargs="+", help="keyword=price, e.g. madrid=180")
    parser.add_argument("--dry-run", action="store_true", help="preview, do not write")
    args = parser.parse_args()
    bases = _parse_pairs(args.pairs)
    asyncio.run(run(bases, apply=not args.dry_run))
    print("done." if not args.dry_run else "dry run — re-run without --dry-run to apply")


if __name__ == "__main__":
    main()
