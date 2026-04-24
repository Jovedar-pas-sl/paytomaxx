#!/usr/bin/env python3
"""
Hash an admin password with bcrypt (cost 12) and print the hash.

Usage:
    python scripts/hash-admin-password.py
    # (prompts for password — nothing is written to disk)
"""
from __future__ import annotations

import getpass
import sys


def _lazy_import_bcrypt():
    try:
        import bcrypt  # type: ignore[import-not-found]

        return bcrypt
    except ModuleNotFoundError:
        print("ERROR: bcrypt not installed. Run: pip install bcrypt", file=sys.stderr)
        sys.exit(1)


def main() -> int:
    bcrypt = _lazy_import_bcrypt()

    # getpass does not echo — safer than input()
    pw1 = getpass.getpass("Admin password: ")
    if len(pw1) < 8:
        print("ERROR: password must be at least 8 characters.", file=sys.stderr)
        return 1
    pw2 = getpass.getpass("Confirm password: ")
    if pw1 != pw2:
        print("ERROR: passwords do not match.", file=sys.stderr)
        return 1

    hashed = bcrypt.hashpw(pw1.encode("utf-8"), bcrypt.gensalt(rounds=12))
    print()
    print("Bcrypt hash (paste this as KPI_ADMIN_PASSWORD_HASH in .env):")
    print()
    print(hashed.decode("utf-8"))
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
