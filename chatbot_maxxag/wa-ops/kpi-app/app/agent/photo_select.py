"""Deterministic photo-card selection for the WhatsApp agent (F2, auto mode).

Sara offers girls in TEXT, then the chat dies where a human would send a photo.
After her text reply this module decides WHICH girls' photos to send as cards —
cheaply and deterministically, with NO extra LLM call:

  * Primary: the girls Sara just NAMED in her reply (accent-insensitive,
    case-insensitive substring match), in reply order.
  * Fallback: if the INCOMING client message shows photo intent and the reply
    named no girl, take the first 1-2 candidates by the existing sort order.

The candidate set is the girls already loaded for the reply, narrowed to those
that are available today AND have a non-empty photo_url. A HARD CAP of
`_MAX_PHOTOS` per reply is enforced (media floods are a strong ban signal), and
duplicates are removed while preserving order.

Pure + side-effect free (no DB, no network) so it is trivially unit-testable;
the caller (`auto_reply`) owns the WAHA send + anti-ban + persistence.
"""
from __future__ import annotations

import re
import unicodedata

from app.queries import GirlRow

# HARD CAP: at most this many photos per reply. Media floods are a strong ban
# signal, so this cap is never exceeded regardless of how many girls matched.
_MAX_PHOTOS = 2

# Max services rendered in a card caption (keep captions tight).
_MAX_CAPTION_SERVICES = 2

# Photo-intent keywords in the INCOMING client message (already accent-folded
# before matching, so "enseñame"/"mándame" are matched without their accents).
# Each is matched as a whole word to avoid false positives inside longer words.
_PHOTO_INTENT_KEYWORDS: frozenset[str] = frozenset(
    {
        "foto",
        "fotos",
        "fotitos",
        "foticos",
        "pics",
        "photo",
        "imagen",
        "ver",
        "ensename",   # enseñame, folded
        "mandame",    # mándame, folded
        "manda",
    }
)


def _fold(text: str) -> str:
    """Lowercase + strip accents (NFKD → ASCII) for robust matching.

    Mirrors the project's existing accent-folding idiom (routes/exports.py).
    'José' → 'jose', 'Mariña' → 'marina', 'enseñame' → 'ensename'.
    """
    if not text:
        return ""
    decomposed = unicodedata.normalize("NFKD", text)
    ascii_only = decomposed.encode("ascii", "ignore").decode()
    return ascii_only.lower()


def fold(text: str) -> str:
    """Public accent/case folding used for girl-name matching. Exposed so other
    modules (e.g. per-client memory dedup) fold identically without reaching into
    the private `_fold`."""
    return _fold(text)


def _has_photo_intent(incoming_text: str) -> bool:
    """True if the incoming client message contains a photo-request keyword.

    Tokenizes the accent-folded text on non-word boundaries so keywords match as
    whole words ("ver" matches "quiero ver" but not "verde").
    """
    folded = _fold(incoming_text)
    tokens = set(re.findall(r"[a-z0-9]+", folded))
    return bool(tokens & _PHOTO_INTENT_KEYWORDS)


def _is_candidate(girl: GirlRow) -> bool:
    """A girl can be a photo card iff available today AND has a non-empty url."""
    return bool(girl.available_today and girl.photo_url and girl.photo_url.strip())


def _named_in_reply(folded_reply: str, girl: GirlRow) -> bool:
    """True if the girl's (accent-folded) name appears in the folded reply.

    Substring match on a folded name: short/empty names are skipped to avoid
    spurious one-letter hits.
    """
    name = _fold(girl.name).strip()
    if len(name) < 2:
        return False
    return name in folded_reply


def match_named_girls(text: str, girls: list[GirlRow]) -> list[GirlRow]:
    """Return the girls whose (accent/case-folded) name appears in `text`, in the
    order the name first appears in the text.

    Public, reusable name-matcher built on the SAME folding/substring logic as the
    photo selection (`_fold` + `_named_in_reply`), so callers (e.g. detecting which
    girls the CLIENT named for per-client memory) match exactly like the photo
    layer — no re-implementation of folding. Pure + side-effect free.
    """
    folded = _fold(text)
    if not folded:
        return []
    named = [g for g in girls if _named_in_reply(folded, g)]
    named.sort(key=lambda g: (folded.find(_fold(g.name).strip()),))
    return named


def select_photo_girls(
    girls: list[GirlRow], reply_text: str, incoming_text: str
) -> list[GirlRow]:
    """Pick which girls' photos to send after Sara's text reply.

    Deterministic, no LLM. Steps:
      1. Build candidates = girls available today WITH a non-empty photo_url
         (input order is the casa sort order, preserved).
      2. PRIMARY — girls whose name appears in `reply_text` (accent/case-
         insensitive), in REPLY order (the order Sara mentioned them).
      3. FALLBACK — only if NO girl was named AND the incoming client message
         shows photo intent: take the first candidates by sort order.
      4. De-dup (preserve order) and HARD-CAP at `_MAX_PHOTOS`.

    Returns at most `_MAX_PHOTOS` `GirlRow`s, each guaranteed to have a photo_url.
    Returns [] when there is nothing safe/relevant to send.
    """
    candidates = [g for g in girls if _is_candidate(girl=g)]
    if not candidates:
        return []

    # PRIMARY: candidates Sara named, ordered by where the name appears in the
    # reply (reply order). Reuses the shared name-matcher so the photo layer and
    # the per-client-memory extraction fold/match identically.
    named = match_named_girls(reply_text, candidates)

    selected: list[GirlRow]
    if named:
        selected = named
    elif _has_photo_intent(incoming_text):
        # FALLBACK: client asked for photos but the reply named nobody — send the
        # first 1-2 candidates so the chat does not die on the photo request.
        selected = candidates
    else:
        return []

    # De-dup by girl id (preserve order) and enforce the hard cap.
    seen: set[int] = set()
    deduped: list[GirlRow] = []
    for girl in selected:
        if girl.id in seen:
            continue
        seen.add(girl.id)
        deduped.append(girl)
        if len(deduped) >= _MAX_PHOTOS:
            break
    return deduped


def build_caption(girl: GirlRow) -> str:
    """Short photo-card caption: '<name>, <age> · <nationality>' + up to 2 svcs.

    Tight by design — long captions read like spam. Missing age/nationality are
    omitted gracefully; services are appended only when present.
    """
    head = girl.name.strip()
    if girl.age:
        head = f"{head}, {int(girl.age)}"
    if girl.nationality and girl.nationality.strip():
        head = f"{head} · {girl.nationality.strip()}"
    svcs = [str(s).strip() for s in (girl.services or []) if str(s).strip()]
    if svcs:
        head = f"{head}\n{', '.join(svcs[:_MAX_CAPTION_SERVICES])}"
    return head
