#!/usr/bin/env python3
"""Seed casa_profile + girl from the WordPress plugin JSON (F0 bootstrap).

One-shot import of the per-city knowledge that lives in the maxxag-chat plugin
(data/config.json + data/girls.json) into the wa-ops tables created by migration
0013. After this, wa-ops is the single source of truth shared by the web widget
and the WhatsApp agent (see docs/SPEC-AGENT-WHATSAPP.md).

Idempotent: re-running upserts (casa_profile by casa_id, girl by casa_id+ext_id),
so it is safe to run again after editing the JSON.

Casa matching is SAFE — it never creates casas and never guesses:
  1. explicit override in CASA_MAP (folder -> casa.name), else
  2. exact case-insensitive match on casa.name, else
  3. unique match on a city keyword, else
  4. warn and SKIP that plugin (you then add it to CASA_MAP).

Usage (dry-run prints what would change, writes nothing):
    python seed_knowledge.py --plugins-dir /path/to/wordpress-plugin
    python seed_knowledge.py --plugins-dir ... --apply        # commit changes
    python seed_knowledge.py --list-casas                     # print DB casas, exit

DATABASE_URL is read from --database-url or the env var (asyncpg DSN). Inside the
kpi-app container the env var already points at the `postgres` service.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

import asyncpg

# ── Plugin folder -> (expected site.name, city keyword for fuzzy match) ──────
# The bare `maxxag-chat-vlc` folder is an unconfigured template (NOMBRE_DEL_SITIO)
# and is intentionally absent.
PLUGINS: list[tuple[str, str, str]] = [
    ("maxxag-chat", "Maxxage Valencia", "vlc"),
    ("maxxag-chat-madrid", "Maxxage Madrid", "madrid"),
    ("maxxag-chat-marbella", "Mansión Babylon Marbella", "marbella"),
    ("maxxag-chat-ibiza", "Maxxag Ibiza", "ibiza"),
]

# Explicit folder -> casa.name override. Fill this in if auto-match fails for a
# plugin (the script prints the available casa names when it can't match).
CASA_MAP: dict[str, str] = {}

LANGS = ("es", "en", "fr", "it")
DEFAULT_SURCHARGE_PCT = 20  # the "+20% del taxi por si acaso" buffer (spec §8)


def _greetings(site: dict[str, Any]) -> dict[str, str]:
    return {lang: site[f"greeting_{lang}"] for lang in LANGS if site.get(f"greeting_{lang}")}


def _outcall_scaffold() -> dict[str, Any]:
    # Pricing is filled later via the panel editor / F3. We only seed the buffer
    # default so the shape is stable for the reply engine.
    return {
        "base_price_eur": None,
        "taxi_surcharge_pct": DEFAULT_SURCHARGE_PCT,
        "tariff": {"base_fare": None, "per_km": None, "per_min": None,
                   "min_fare": None, "night_mult": 1.0},
    }


def _resolve_casa(folder: str, site_name: str, keyword: str,
                  casas: list[asyncpg.Record]) -> int | None:
    """Map a plugin to a casa.id without guessing. Returns None if unresolved."""
    by_name = {c["name"].strip().lower(): c["id"] for c in casas}

    override = CASA_MAP.get(folder)
    if override:
        cid = by_name.get(override.strip().lower())
        if cid is None:
            print(f"  ! CASA_MAP['{folder}'] = '{override}' not found among casas")
        return cid

    cid = by_name.get(site_name.strip().lower())
    if cid is not None:
        return cid

    hits = [c["id"] for c in casas if keyword in c["name"].lower()]
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        print(f"  ! '{keyword}' is ambiguous across casas — add CASA_MAP['{folder}']")
    return None


async def _upsert_profile(conn: asyncpg.Connection, casa_id: int,
                          cfg: dict[str, Any], apply: bool) -> None:
    site = cfg.get("site", {})
    schedule = cfg.get("schedule", {})
    row = {
        "bot_name": site.get("bot_name") or site.get("name"),
        "whatsapp_recepcion": site.get("whatsapp_recepcion"),
        "telegram_recepcion": site.get("telegram_recepcion"),
        "greetings": json.dumps(_greetings(site)),
        "rates": json.dumps(cfg.get("rates", {})),
        "schedule": json.dumps(schedule),
        "faqs": json.dumps(cfg.get("faqs", [])),
        "outcall": json.dumps(_outcall_scaffold()),
        "address": schedule.get("address_es"),
        "maps_url": schedule.get("maps_url"),
    }
    if not apply:
        print(f"    profile: bot={row['bot_name']!r} wa={row['whatsapp_recepcion']}")
        return
    await conn.execute(
        """
        INSERT INTO casa_profile
          (casa_id, bot_name, default_lang, whatsapp_recepcion, telegram_recepcion,
           greetings, rates, schedule, faqs, outcall, address, maps_url, updated_at)
        VALUES ($1,$2,'es',$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11, now())
        ON CONFLICT (casa_id) DO UPDATE SET
           bot_name = EXCLUDED.bot_name,
           whatsapp_recepcion = EXCLUDED.whatsapp_recepcion,
           telegram_recepcion = EXCLUDED.telegram_recepcion,
           greetings = EXCLUDED.greetings,
           rates = EXCLUDED.rates,
           schedule = EXCLUDED.schedule,
           faqs = EXCLUDED.faqs,
           -- preserve outcall pricing edited in the panel; only seed if empty
           outcall = CASE WHEN casa_profile.outcall = '{}'::jsonb
                          THEN EXCLUDED.outcall ELSE casa_profile.outcall END,
           address = EXCLUDED.address,
           maps_url = EXCLUDED.maps_url,
           updated_at = now()
        """,
        casa_id, row["bot_name"], row["whatsapp_recepcion"], row["telegram_recepcion"],
        row["greetings"], row["rates"], row["schedule"], row["faqs"], row["outcall"],
        row["address"], row["maps_url"],
    )


async def _upsert_girls(conn: asyncpg.Connection, casa_id: int,
                        girls: list[dict[str, Any]], apply: bool) -> int:
    n = 0
    for idx, g in enumerate(girls):
        ext_id = g.get("id")
        if not g.get("name"):
            continue
        n += 1
        if not apply:
            continue
        await conn.execute(
            """
            INSERT INTO girl
              (casa_id, ext_id, name, age, nationality, description, photo_url,
               whatsapp, available_today, outcall, escort_pareja, services,
               languages, sort_order, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14, now())
            ON CONFLICT (casa_id, ext_id) WHERE ext_id IS NOT NULL DO UPDATE SET
               name = EXCLUDED.name, age = EXCLUDED.age,
               nationality = EXCLUDED.nationality, description = EXCLUDED.description,
               photo_url = EXCLUDED.photo_url, whatsapp = EXCLUDED.whatsapp,
               available_today = EXCLUDED.available_today, outcall = EXCLUDED.outcall,
               escort_pareja = EXCLUDED.escort_pareja, services = EXCLUDED.services,
               languages = EXCLUDED.languages, updated_at = now()
            """,
            casa_id, ext_id, g["name"], g.get("age"), g.get("nationality"),
            g.get("description"), g.get("photo_url"), g.get("whatsapp"),
            bool(g.get("available_today", True)), bool(g.get("outcall", False)),
            bool(g.get("escort_pareja", False)), json.dumps(g.get("services", [])),
            json.dumps(g.get("languages", [])), idx,
        )
    return n


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


async def main() -> int:
    ap = argparse.ArgumentParser(description="Seed casa_profile + girl from plugin JSON")
    ap.add_argument("--plugins-dir", type=Path,
                    help="path to wordpress-plugin/ (contains maxxag-chat*/data/*.json)")
    ap.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    ap.add_argument("--apply", action="store_true", help="commit changes (default: dry-run)")
    ap.add_argument("--list-casas", action="store_true", help="print DB casas and exit")
    args = ap.parse_args()

    if not args.database_url:
        print("ERROR: no DATABASE_URL (pass --database-url or set the env var)", file=sys.stderr)
        return 2

    # Normalize SQLAlchemy-style DSNs (postgresql+asyncpg://) — asyncpg wants a bare scheme.
    scheme, sep, rest = args.database_url.partition("://")
    dsn = f"{scheme.split('+', 1)[0]}{sep}{rest}" if sep else args.database_url

    conn = await asyncpg.connect(dsn)
    try:
        casas = await conn.fetch("SELECT id, name FROM casa ORDER BY name")
        if args.list_casas:
            print("Casas in DB:")
            for c in casas:
                print(f"  [{c['id']}] {c['name']}")
            return 0
        if not args.plugins_dir:
            print("ERROR: --plugins-dir is required (or use --list-casas)", file=sys.stderr)
            return 2

        mode = "APPLY" if args.apply else "DRY-RUN"
        print(f"=== seed knowledge ({mode}) — {len(casas)} casas in DB ===")
        total_g = 0
        for folder, site_name, keyword in PLUGINS:
            base = args.plugins_dir / folder / "data"
            cfg_path, girls_path = base / "config.json", base / "girls.json"
            if not cfg_path.exists():
                print(f"- {folder}: no config.json, skip")
                continue
            casa_id = _resolve_casa(folder, site_name, keyword, casas)
            if casa_id is None:
                print(f"- {folder} ({site_name!r}): NO casa match — SKIPPED "
                      f"(add CASA_MAP['{folder}'])")
                continue
            cfg = _load(cfg_path)
            girls = _load(girls_path).get("girls", []) if girls_path.exists() else []
            print(f"- {folder} -> casa #{casa_id} ({site_name})")
            await _upsert_profile(conn, casa_id, cfg, args.apply)
            n = await _upsert_girls(conn, casa_id, girls, args.apply)
            total_g += n
            print(f"    girls: {n}")
        print(f"=== done. girls processed: {total_g}. "
              f"{'written' if args.apply else 'dry-run (nothing written)'} ===")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
