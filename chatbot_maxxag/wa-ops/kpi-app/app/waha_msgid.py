"""Shared WAHA send-response id extraction.

Both the receptionist send route (`routes/conversation.py`) and the agent
auto-reply job (`agent/auto_reply.py`) insert their outbound message with the
real WAHA message id so the later `message.any` (fromMe=true) webhook hits
ON CONFLICT (waha_msg_id) DO NOTHING and is a no-op — preventing duplicates.
This pure helper is the single place that knows the WAHA response shape.
"""
from __future__ import annotations


def extract_waha_msg_id(res: object) -> str:
    """Extract the WAHA message id from a send_text response.

    WAHA returns `id` either as a string or as a nested dict
    `{"_serialized": "...", "id": "..."}`. The NOWEB/GOWS (Baileys) engine
    instead returns the raw WA message with the id under `key`
    `{"remoteJid": ..., "fromMe": ..., "id": ...}`. Some legacy engines nest it
    under `_data.id`. Returns "" if no id can be extracted.
    """
    if not isinstance(res, dict):
        return ""
    top = res.get("id")
    if isinstance(top, str):
        return top
    if isinstance(top, dict):
        cand = top.get("_serialized") or top.get("id")
        if isinstance(cand, str):
            return cand
    # NOWEB/GOWS (Baileys): id lives under `key`. The webhook stores data["id"]
    # in WAHA's serialized form `{true|false}_{remoteJid}_{id}`; reconstruct it
    # so the agent insert and the later message.any echo dedup on the SAME id.
    key = res.get("key")
    if isinstance(key, dict):
        kid = key.get("id")
        remote = key.get("remoteJid") or key.get("remote")
        if isinstance(kid, str) and isinstance(remote, str):
            prefix = "true" if key.get("fromMe") else "false"
            return f"{prefix}_{remote}_{kid}"
        if isinstance(kid, str):
            return kid
    inner = (res.get("_data") or {}).get("id") if isinstance(res.get("_data"), dict) else None
    if isinstance(inner, str):
        return inner
    if isinstance(inner, dict):
        cand = inner.get("_serialized") or inner.get("id")
        if isinstance(cand, str):
            return cand
    return ""
