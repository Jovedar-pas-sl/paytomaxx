#!/usr/bin/env python3
"""Build WordPress plugin ZIPs with forward-slash paths for Linux hosting."""
import os
import sys
import zipfile
from pathlib import Path

VERSION = "5.4.1"
ROOT = Path(__file__).parent.resolve()

# (source_dir_name, plugin_folder_name, zip_basename)
TARGETS = [
    ("maxxag-chat",          "maxxag-chat",          "maxxag-chat"),
    ("maxxag-chat-vlc",      "maxxChatBot",          "maxxChatBot"),
    ("maxxag-chat-madrid",   "maxxag-chat",          "maxxag-chat-madrid"),
    ("maxxag-chat-marbella", "maxxag-chat",          "maxxag-chat-marbella"),
    ("maxxag-chat-ibiza",    "maxxag-chat",          "maxxag-chat-ibiza"),
]

# Files/dirs to exclude from ZIPs
EXCLUDE_NAMES = {".DS_Store", "Thumbs.db", "__pycache__", ".git", "node_modules"}
EXCLUDE_EXT = {".pyc", ".log"}

def should_skip(p: Path) -> bool:
    if p.name in EXCLUDE_NAMES:
        return True
    if p.suffix in EXCLUDE_EXT:
        return True
    return False

def build_zip(src_dir: Path, plugin_folder: str, out_zip: Path):
    if not src_dir.exists():
        print(f"  ! source missing: {src_dir}")
        return False
    count = 0
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for root, dirs, files in os.walk(src_dir):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_NAMES]
            for fname in files:
                fpath = Path(root) / fname
                if should_skip(fpath):
                    continue
                rel = fpath.relative_to(src_dir).as_posix()  # forward slashes
                arcname = f"{plugin_folder}/{rel}"
                zf.write(fpath, arcname)
                count += 1
    print(f"  ok {out_zip.name} ({count} files)")
    return True

def main():
    print(f"Building v{VERSION} ZIPs...")
    for src_name, plugin_folder, zip_base in TARGETS:
        src = ROOT / src_name
        out = ROOT / f"{zip_base}_v{VERSION}.zip"
        # Also write the "latest" alias
        latest = ROOT / f"{zip_base}.zip"
        ok = build_zip(src, plugin_folder, out)
        if ok:
            # Copy to latest alias
            import shutil
            shutil.copy2(out, latest)
            print(f"  -> {latest.name}")
    print("Done.")

if __name__ == "__main__":
    main()
