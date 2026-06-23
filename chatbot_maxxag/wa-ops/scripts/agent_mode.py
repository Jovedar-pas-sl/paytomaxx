#!/usr/bin/env python3
"""List WhatsApp numbers and toggle the agent mode (off / auto / copilot).

The agent only acts on a number whose mode is 'auto' (sends) or 'copilot'
(stores a suggestion, never sends). Default is 'off' — nothing replies.

Run inside the kpi-app container (DATABASE_URL is in the env):
    docker compose exec -u root -T kpi-app python /tmp/agent_mode.py --list
    docker compose exec -u root -T kpi-app python /tmp/agent_mode.py --set 5 copilot
    docker compose exec -u root -T kpi-app python /tmp/agent_mode.py --set 5 auto
    docker compose exec -u root -T kpi-app python /tmp/agent_mode.py --set 5 off
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

import asyncpg

MODES = ("off", "auto", "copilot")


async def _list(conn: asyncpg.Connection) -> None:
    rows = await conn.fetch(
        """
        SELECT w.id, w.label, w.phone, w.mode, c.name AS casa
        FROM wa_number w
        JOIN casa c ON c.id = w.casa_id
        ORDER BY c.name, w.id
        """
    )
    print(f"{'id':>4}  {'mode':<8} {'casa':<28} {'label':<14} phone")
    print("-" * 70)
    for r in rows:
        print(
            f"{r['id']:>4}  {r['mode']:<8} {r['casa'][:28]:<28} "
            f"{(r['label'] or '')[:14]:<14} {r['phone'] or ''}"
        )


async def _set(conn: asyncpg.Connection, wa_id: int, mode: str) -> None:
    res = await conn.execute(
        "UPDATE wa_number SET mode = $1 WHERE id = $2", mode, wa_id
    )
    if res.endswith("0"):
        print(f"! no wa_number with id={wa_id}", file=sys.stderr)
    else:
        print(f"OK: wa_number {wa_id} -> mode '{mode}'")


async def main() -> int:
    ap = argparse.ArgumentParser(description="List/toggle agent mode per WhatsApp number")
    ap.add_argument("--list", action="store_true", help="list numbers and modes")
    ap.add_argument("--set", nargs=2, metavar=("WA_ID", "MODE"),
                    help="set a number's mode (off|auto|copilot)")
    ap.add_argument("--reset", metavar="CONV_ID",
                    help="clear a conversation's agent pause (back to active)")
    ap.add_argument("--reset-all-paused", action="store_true",
                    help="reset ALL paused (human/risk) conversations back to active")
    ap.add_argument("--diag", action="store_true",
                    help="dump the last 20 messages with conv status + wa mode (DB truth)")
    ap.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    args = ap.parse_args()

    if not args.database_url:
        print("ERROR: no DATABASE_URL (set the env var)", file=sys.stderr)
        return 2

    scheme, sep, rest = args.database_url.partition("://")
    dsn = f"{scheme.split('+', 1)[0]}{sep}{rest}" if sep else args.database_url

    conn = await asyncpg.connect(dsn)
    try:
        if args.set:
            wa_id, mode = args.set
            if mode not in MODES:
                print(f"ERROR: mode must be one of {MODES}", file=sys.stderr)
                return 2
            await _set(conn, int(wa_id), mode)
            print()
        if args.reset:
            res = await conn.execute(
                "UPDATE conversation SET agent_status = 'active', "
                "agent_paused_at = NULL WHERE id = $1",
                int(args.reset),
            )
            print(f"reset conversation {args.reset} -> active ({res})\n")
        if args.reset_all_paused:
            res = await conn.execute(
                "UPDATE conversation SET agent_status = 'active', agent_paused_at = NULL "
                "WHERE agent_status IN ('paused_human', 'paused_risk')"
            )
            print(f"reset ALL paused conversations -> active ({res})\n")
        if args.diag:
            rows = await conn.fetch(
                """
                SELECT m.created_at AT TIME ZONE 'Europe/Madrid' AS ts,
                       m.direction AS dir, m.agent_generated AS ag,
                       c.id AS conv, c.agent_status AS status, w.mode AS mode,
                       left(coalesce(m.body, ''), 32) AS body
                FROM message m
                JOIN conversation c ON c.id = m.conversation_id
                LEFT JOIN wa_number w ON w.id = c.wa_number_id
                ORDER BY m.created_at DESC
                LIMIT 20
                """
            )
            print(f"{'time':<19} {'dir':<3} {'ag':<5} {'conv':>7} "
                  f"{'status':<12} {'mode':<8} body")
            print("-" * 92)
            for r in rows:
                print(f"{str(r['ts'])[:19]:<19} {r['dir']:<3} {str(r['ag']):<5} "
                      f"{r['conv']:>7} {(r['status'] or 'active'):<12} "
                      f"{(r['mode'] or '?'):<8} {r['body']}")
            print()
            return 0
        await _list(conn)
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
