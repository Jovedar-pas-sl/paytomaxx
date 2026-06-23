#!/usr/bin/env python3
"""One-off: set each casa's coordinates (casa_profile.address_lat/address_lng).

F3 needs each casa's coordinates to measure the Haversine distance to the
client's location PIN. When the address feed is empty/non-geocodable (so
geocode_casas.py finds nothing), set the coordinates directly here — city-centre
as a quick approximation, or the casa's real lat/lng for precise pricing.

Casas are matched by NAME keyword (vlc/madrid/marbella/ibiza/...), so ids never
have to be hard-coded. Idempotent — re-running just re-sets the values.

Usage (inside the kpi-app container; DATABASE_URL from the env):
    python set_casa_coords.py vlc=39.4699,-0.3763 madrid=40.4168,-3.7038 \
                              marbella=36.5101,-4.8826 ibiza=38.9067,1.4206
    python set_casa_coords.py --dry-run vlc=39.4699,-0.3763     # preview only
"""
from __future__ import annotations

import argparse
import asyncio
import os
import re
import sys

import asyncpg

_LAT_MIN, _LAT_MAX = -90.0, 90.0
_LNG_MIN, _LNG_MAX = -180.0, 180.0


def _dsn_from_env() -> str:
    """Read DATABASE_URL and strip any SQLAlchemy '+driver' suffix for asyncpg."""
    raw = os.environ.get("DATABASE_URL")
    if not raw:
        sys.exit("DATABASE_URL not set in the environment")
    return re.sub(r"^postgresql\+\w+://", "postgresql://", raw)


def _parse_pairs(pairs: list[str]) -> dict[str, tuple[float, float]]:
    """Parse `keyword=lat,lng` args into {keyword: (lat, lng)}, validating each."""
    out: dict[str, tuple[float, float]] = {}
    for pair in pairs:
        key, _, coords = pair.partition("=")
        key = key.strip().lower()
        try:
            lat_s, lng_s = coords.split(",")
            lat, lng = float(lat_s), float(lng_s)
        except ValueError:
            sys.exit(f"bad arg {pair!r} — expected keyword=lat,lng e.g. madrid=40.41,-3.70")
        if not key:
            sys.exit(f"bad arg {pair!r} — empty keyword")
        if not (_LAT_MIN <= lat <= _LAT_MAX and _LNG_MIN <= lng <= _LNG_MAX):
            sys.exit(f"bad coords in {pair!r} — out of WGS-84 range")
        out[key] = (lat, lng)
    return out


async def run(coords: dict[str, tuple[float, float]], apply: bool) -> None:
    conn = await asyncpg.connect(_dsn_from_env())
    try:
        for keyword, (lat, lng) in coords.items():
            rows = await conn.fetch(
                "SELECT id, name FROM casa WHERE name ILIKE $1", f"%{keyword}%"
            )
            if not rows:
                print(f"{keyword}: NO CASA matched — skipped")
                continue
            for r in rows:
                tag = "" if apply else " [DRY RUN]"
                print(f"{keyword}: casa {r['id']} ({r['name']}) -> ({lat:.5f}, {lng:.5f}){tag}")
                if apply:
                    await conn.execute(
                        "UPDATE casa_profile SET address_lat = $2, address_lng = $3 WHERE casa_id = $1",
                        r["id"], lat, lng,
                    )
    finally:
        await conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Set casa coordinates (one-off).")
    parser.add_argument("pairs", nargs="+", help="keyword=lat,lng e.g. madrid=40.4168,-3.7038")
    parser.add_argument("--dry-run", action="store_true", help="preview, do not write")
    args = parser.parse_args()
    coords = _parse_pairs(args.pairs)
    asyncio.run(run(coords, apply=not args.dry_run))
    print("done." if not args.dry_run else "dry run — re-run without --dry-run to apply")


if __name__ == "__main__":
    main()
