#!/usr/bin/env python3
"""Block commits that contain real secrets.

Used as a pre-commit hook (see .pre-commit-config.yaml). Scans the files passed
as arguments (pre-commit passes the staged files) for high-signal secret
patterns and exits non-zero if any are found.

Safe placeholders (REPLACE_ME, CHANGE_ME, x's, ...) are explicitly allowed so
that .env.example and templates do not trip the guard.

Run manually:  python scripts/check-secrets.py path/to/file ...
"""

from __future__ import annotations

import re
import sys

# (name, compiled pattern). Each pattern targets a real credential shape.
PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    # Anthropic API keys: sk-ant-... followed by a long token body.
    ("Anthropic API key", re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}")),
    # Generic OpenAI-style keys (defence in depth).
    ("OpenAI-style API key", re.compile(r"sk-[A-Za-z0-9]{32,}")),
    # AWS access key id.
    ("AWS access key id", re.compile(r"AKIA[0-9A-Z]{16}")),
    # Private key blocks.
    ("Private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
]

# Substrings that mark a value as a deliberate placeholder — never a real secret.
PLACEHOLDER_MARKERS = (
    "REPLACE_ME",
    "CHANGE_ME",
    "your-",
    "YOUR_",
    "example",
    "EXAMPLE",
    "xxxx",
    "XXXX",
    "<",  # e.g. <token>
    "...",
)

# Binary / vendored / generated paths we never scan.
SKIP_SUFFIXES = (
    ".lock",
    ".min.js",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".pdf",
    ".woff",
    ".woff2",
    ".ico",
)
SKIP_DIRS = ("node_modules/", ".git/", "dist/", "build/", "__pycache__/")


def _is_placeholder(line: str) -> bool:
    return any(marker in line for marker in PLACEHOLDER_MARKERS)


def _should_skip(path: str) -> bool:
    normalized = path.replace("\\", "/")
    if any(d in normalized for d in SKIP_DIRS):
        return True
    return normalized.endswith(SKIP_SUFFIXES)


def scan_file(path: str) -> list[str]:
    """Return a list of human-readable findings for a single file."""
    findings: list[str] = []
    try:
        with open(path, encoding="utf-8", errors="ignore") as fh:
            for lineno, line in enumerate(fh, start=1):
                if _is_placeholder(line):
                    continue
                for name, pattern in PATTERNS:
                    if pattern.search(line):
                        findings.append(f"{path}:{lineno}: possible {name}")
    except (OSError, UnicodeError):
        # Unreadable / binary — nothing to scan.
        return []
    return findings


def main(argv: list[str]) -> int:
    files = [p for p in argv if not _should_skip(p)]
    all_findings: list[str] = []
    for path in files:
        all_findings.extend(scan_file(path))

    if all_findings:
        print("BLOCKED: potential secret(s) detected in staged changes:\n")
        for finding in all_findings:
            print(f"  {finding}")
        print(
            "\nRemove the secret or replace it with a placeholder "
            "(e.g. sk-ant-REPLACE_ME, CHANGE_ME).\n"
            "If this is a false positive, scrub the value before committing."
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
