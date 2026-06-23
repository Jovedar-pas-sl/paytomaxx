"""WhatsApp reply engine — generate a 100%-human reply that CLOSES the booking.

F1 of the WhatsApp-agent spec. This is the single LLM-first path: it loads the
casa knowledge (profile + girls available today) and the last few message turns,
builds a localized persona system prompt (see `app.agent.persona`), calls Claude
Haiku 4.5 through the shared `_call_text` helper, and returns plain text ready to
send via WAHA.

DEFERRED (YAGNI): WhatsApp has no quick-reply / menu buttons over WAHA, so the
web widget's deterministic router (back-to-menu, lang switch, FAQ matcher,
girl-name detection, contact-intent scan) is intentionally NOT ported — none of
it has a transport here. `lang` is supplied by the caller (no auto-detection),
exactly like the PHP widget. Webhook auto-reply wiring is F2, not here.

Anti-prompt-injection is kept on both edges: every interpolated knowledge field,
the incoming message AND each replayed history turn are sanitized before entering
the prompt, and the model output is leak-checked before it is returned. The
injection regex is best-effort noise reduction, not a hard security boundary —
the real guarantee is that untrusted text only ever enters as a user/history
turn, never the system block.
"""

from __future__ import annotations

import logging
import random
import re
from datetime import datetime

try:  # tz DB (provided by the `tzdata` dep); fail-soft so a reply never breaks
    from zoneinfo import ZoneInfo
except Exception:  # noqa: BLE001
    ZoneInfo = None  # type: ignore[assignment,misc]

import asyncpg

from app import queries
from app.agent import lang_detect, persona, photo_select
from app.agent.persona import DEFAULT_LANG
from app.analyzer.skills import _call_text

logger = logging.getLogger(__name__)


# ── Sanitization constants (ported from claude.php lines 28-35) ──────
# Per-field truncation caps (chars) — keep the prompt small and bound abuse.
_MAXLEN_NAME = 50
_MAXLEN_NATIONALITY = 50
_MAXLEN_DESCRIPTION = 150
_MAXLEN_SERVICES = 100
_MAXLEN_LANGUAGES = 30
_MAXLEN_RATE_LABEL = 50
_MAXLEN_RATE_PRICE = 20
_MAXLEN_INCOMING = 1000
# Curated-FAQ block caps. Bound the prompt even if a casa curates many faqs.
_MAXLEN_FAQ = 220
_MAX_FAQS = 8

# Injection patterns stripped from any text that reaches the prompt.
_INJECTION_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(
        r"\b(ignore|forget|disregard|override|bypass|execute|act as|pretend|"
        r"roleplay|jailbreak).{0,30}\b(instructions?|rules?|prompt|system|"
        r"previous|above)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(system|internal|hidden|secret)\s*(prompt|instruction|rules?|message)",
        re.IGNORECASE,
    ),
    re.compile(r"\b(DAN|developer mode|admin mode|god mode)\b", re.IGNORECASE),
    # Spanish override verbs near an instruction/rules/prompt/system noun. 97% of
    # clients write Spanish, so the English-only patterns above missed the most
    # likely injection. Strips "ignora las instrucciones anteriores", "olvida las
    # reglas del sistema", "anula el prompt", etc.
    re.compile(
        r"\b(ignora|ignorar|olvida|olvidar|olv[ií]date|descarta|descartar|"
        r"anula|anular|omite|omitir|s[áa]ltate|salta|desactiva|act[úu]a\s+como|"
        r"comp[óo]rtate)\b.{0,40}\b(instrucci[oó]n(?:es)?|reglas?|prompt|sistema|"
        r"anterior(?:es)?|previo|previas?)\b",
        re.IGNORECASE,
    ),
)

_TAG_RE = re.compile(r"<[^>]*>")            # strip_tags equivalent
_CONTROL_RE = re.compile(r"[\x00-\x1F]")    # control chars (incl. newlines)

# Output leak markers (port of claude.php lines 271-281): if the reply contains
# any of these the model likely echoed the system prompt / a key — discard it.
_LEAK_MARKERS: tuple[str, ...] = (
    "system prompt:",
    "api_key",
    "sk-ant-",
    # Internal-hint label stems (per language). If Sara ever echoes the analyzer
    # hint label verbatim, the deterministic filter discards the reply into the
    # fallback — closing the residual second-order echo path.
    "pista interna",
    "internal hint",
    "indice interne",
    "suggerimento interno",
    # Per-client memory label stems (per language). Mirror the hint stems so an
    # echoed memory LABEL is caught. NOTE: only the internal label is a marker —
    # the remembered GIRL NAMES are deliberately NOT markers, because re-offering
    # the remembered girl by name is the whole point of the feature.
    "memoria del cliente",   # es + it share this stem
    "client memory",
    "mémoire du client",     # fr label (kept accented: _has_leak lowercases only)
    # Outcall-price label stems (F3, per language). Mirror the hint/memory stems
    # so an echoed outcall LABEL (priced OR defer) is discarded. The es priced
    # and defer labels share the "desplazamiento" stem; "spostamento" covers both
    # it variants; "déplacement" covers both fr variants; en uses "outcall".
    "precio de desplazamiento",   # es priced
    "desplazamiento sin precio",  # es defer
    "outcall price",              # en priced
    "outcall without price",      # en defer
    "prix du déplacement",        # fr priced
    "déplacement sans prix",      # fr defer
    "prezzo dello spostamento",   # it priced
    "spostamento senza prezzo",   # it defer
    # Venue/FAQ label stems (per language). Mirror the hint/memory/outcall stems
    # so an echoed venue LABEL is discarded. Only the internal label is a marker —
    # the address/maps themselves are shareable (Sara SHOULD tell clients where
    # the venue is), so they are deliberately NOT markers.
    "info del local",   # es + it share this stem
    "venue info",       # en
    "infos du lieu",    # fr
    "info del locale",  # it
    # Style-examples label stems (Wave 2, per language). Mirror the other stems
    # so an echoed "how the team replies" LABEL is discarded into the fallback.
    "así responde el equipo",   # es
    "how the team replies",     # en
    "comment l'équipe répond",  # fr (kept accented: _has_leak lowercases only)
    "come risponde il team",    # it
    # A/B greeting-variant label stems (Wave 3, per language).
    "variante de saludo",       # es
    "greeting variant",         # en
    "variante de salutation",   # fr
    "variante di saluto",       # it
)


def _sanitize_for_prompt(text: str, maxlen: int) -> str:
    """Strip HTML tags, known prompt-injection patterns and control chars, then
    trim and truncate. Applied to every field that enters the system prompt."""
    if not text:
        return ""
    text = _TAG_RE.sub("", text)
    for pattern in _INJECTION_PATTERNS:
        text = pattern.sub("", text)
    text = _CONTROL_RE.sub("", text)
    return text.strip()[:maxlen]


def _sanitize_incoming(text: str) -> str:
    """Sanitize the raw incoming WhatsApp message before it becomes the user
    turn: injection-strip + control-char strip + hard length cap."""
    return _sanitize_for_prompt(text or "", _MAXLEN_INCOMING)


def _build_rates_summary(rates: dict, lang: str) -> str:
    """Render the rates JSONB into '- {label}: {price}' lines (sanitized)."""
    lines: list[str] = []
    for item in rates.get("items", []) or []:
        if not isinstance(item, dict):
            continue
        raw_label = item.get(f"label_{lang}") or item.get("label_es") or ""
        label = _sanitize_for_prompt(str(raw_label), _MAXLEN_RATE_LABEL)
        price = _sanitize_for_prompt(str(item.get("price") or ""), _MAXLEN_RATE_PRICE)
        if label and price:
            lines.append(f"- {label}: {price}")
    return "\n".join(lines)


def _format_girl(girl: queries.GirlRow) -> str:
    """One girls-context line (port of claude.php lines 38-52, sanitized)."""
    name = _sanitize_for_prompt(girl.name, _MAXLEN_NAME)
    age = int(girl.age) if girl.age else 0
    nat = _sanitize_for_prompt(girl.nationality or "", _MAXLEN_NATIONALITY)
    desc = _sanitize_for_prompt(girl.description or "", _MAXLEN_DESCRIPTION)
    svcs = _sanitize_for_prompt(
        ", ".join(str(s) for s in girl.services or []), _MAXLEN_SERVICES
    )
    langs = _sanitize_for_prompt(
        "/".join(str(s) for s in girl.languages or []), _MAXLEN_LANGUAGES
    )
    outcall = "sí" if girl.outcall else "no"
    pareja = "sí" if girl.escort_pareja else "no"
    return (
        f"- {name} ({age} años, {nat}): {desc} "
        f"Servicios: {svcs or 'consultar'}. Idiomas: {langs}. "
        f"Outcall: {outcall}. Parejas: {pareja}"
    )


def _build_girls_ctx(girls: list[queries.GirlRow]) -> str:
    """Render the available-today girls block, or the empty-list line."""
    if not girls:
        return "No hay chicas disponibles ahora mismo."
    return "\n".join(_format_girl(g) for g in girls)


# Payment methods Sara can quote (clients DO ask "¿efectivo o tarjeta?"). Same
# for all casas for now; override per-casa later if one differs.
_DEFAULT_PAYMENT = "efectivo y tarjeta"

_WEEKDAYS_ES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]


def _now_local_str() -> str:
    """Current local time in Spain as 'jueves 03:14' so Sara can tell if she's
    open RIGHT NOW (vs the free-text Horario) and answer '¿estáis ahora?'. The
    weekday is in Spanish (the model translates as needed). Fail-soft to "" so a
    missing tz DB never breaks a reply."""
    if ZoneInfo is None:
        return ""
    try:
        now = datetime.now(ZoneInfo("Europe/Madrid"))
        return f"{_WEEKDAYS_ES[now.weekday()]} {now:%H:%M}"
    except Exception:  # noqa: BLE001
        return ""


def _site_url_for_casa(casa_name: str) -> str:
    """Public website (catalog) URL for a casa so Sara can send the link when a
    client asks who's available. Reuses the website_sync keyword→site map
    (matched against the casa name). Returns "" when the casa has no known
    public site — the persona then NEVER invents a URL (it invites to the venue
    instead). Imported lazily to avoid any import cycle at module load."""
    try:
        from app.agent.website_sync import CASA_SITES
    except Exception:  # noqa: BLE001 — missing map must never break a reply
        return ""
    low = (casa_name or "").lower()
    for kw, site in CASA_SITES.items():
        if kw in low:
            return str(site.get("base", "") or "")
    return ""


def _build_faq_ctx(profile: queries.CasaProfileRow, lang: str) -> str:
    """Render the casa's ADMIN-CURATED FAQ replies (casa_profile.faqs) into the
    localized curated-FAQ block. Each reply is sanitized exactly like the rest of
    the system prompt; returns "" when there are no faqs so the prompt is byte-
    for-byte unchanged for casas without them. Deliberately does NOT inject the
    address/phone (kept out of the prompt by design).

    NOTE: casa_profile.faqs is populated by website_sync ONLY if the casa's
    public /config endpoint exposes `faqs`. The WordPress plugin currently STRIPS
    faqs from the public payload, so this renders nothing until faqs reach
    casa_profile (curate them in the DB or widen the sync — see docs/FAQS.md)."""
    faq_replies: list[str] = []
    for item in (profile.faqs or [])[:_MAX_FAQS]:
        if not isinstance(item, dict):
            continue
        raw = item.get(f"reply_{lang}") or item.get("reply_es") or ""
        clean = _sanitize_for_prompt(str(raw), _MAXLEN_FAQ)
        if clean:
            faq_replies.append(clean)
    return persona.build_faq_block(faq_replies, lang)


def build_system_prompt(
    lang: str, knowledge: queries.CasaKnowledge, client_name: str
) -> str:
    """Build the localized persona system prompt from the loaded casa knowledge.

    Pure + side-effect free (exported for unit testing). Picks the language
    template (falling back to DEFAULT_LANG), then interpolates the sanitized
    bot name, site/casa data, schedule, rates and available girls. Assumes
    `knowledge.profile` is not None (the caller handles the no-profile case).
    """
    profile = knowledge.profile
    assert profile is not None  # caller guarantees this; see generate_reply
    bot_name = _sanitize_for_prompt(profile.bot_name or "", _MAXLEN_NAME) or "recepción"
    # Venue name (e.g. "Maxxage Valencia") is distinct from the bot persona name
    # (e.g. "Sara") — the web widget used both. Fall back to bot_name if missing.
    site_name = _sanitize_for_prompt(profile.casa_name or "", _MAXLEN_NAME) or bot_name
    hours = _sanitize_for_prompt(
        str(profile.schedule.get(f"hours_{lang}")
            or profile.schedule.get("hours_es") or ""),
        _MAXLEN_DESCRIPTION,
    )
    # DISCRECIÓN: nunca exponemos el nombre real del cliente al prompt — los
    # clientes valoran la discreción y Sara NO debe dirigirse a ellos por su
    # nombre. El parámetro client_name se mantiene por la firma, pero no se usa.
    name_ctx = "desconocido"
    rates_summary = _build_rates_summary(profile.rates, lang)
    girls_ctx = _build_girls_ctx(knowledge.girls_available)
    site_url = _site_url_for_casa(profile.casa_name or "")
    # Street address (from the casa's public website, address_es). Injected so
    # Sara can give the ADDRESS — not just the city — when asked where they are.
    # Empty → the persona falls back to city + invite and never invents one.
    address = _sanitize_for_prompt(profile.address or "", _MAXLEN_DESCRIPTION)
    now_local = _now_local_str()

    template = persona.system_prompt_template(lang)
    base = template.format(
        bot_name=bot_name,
        site_name=site_name,
        hours=hours,
        name_ctx=name_ctx,
        rates_summary=rates_summary,
        girls_ctx=girls_ctx,
        site_url=site_url,
        address=address,
        now_local=now_local,
        payment=_DEFAULT_PAYMENT,
    )
    # Append the casa's admin-curated FAQ replies (casa_profile.faqs).
    # Empty → "" so the prompt is byte-for-byte unchanged for casas without them.
    return base + _build_faq_ctx(profile, lang)


def _clean_hint_text(text: str) -> str:
    """Cleanup for hint text destined for the trusted system block: strip HTML
    tags, known prompt-injection patterns, AND control chars. The injection pass
    runs here too (A4/H2): hint.why derives from the raw client message, so an
    injected directive could otherwise reach the system block second-order. The
    authoritative length cap is applied once, by `persona.build_hint_block`."""
    if not text:
        return ""
    text = _TAG_RE.sub("", text)
    for pattern in _INJECTION_PATTERNS:
        text = pattern.sub("", text)
    text = _CONTROL_RE.sub("", text)
    return text.strip()


async def _build_internal_hint(kpi: asyncpg.Pool, conv_id: int, lang: str) -> str:
    """Fetch the analyzer's latest signal for this conversation and render it as
    Sara's internal soft-hint line (to append to the system block). Returns "" —
    no hint, no prompt change — when there is no analysis row, when the action is
    not actionable, or on ANY failure (caller relies on fail-soft).

    Kept self-contained so generate_reply's behavior is byte-for-byte unchanged
    for conversations without analysis. The caller still wraps the whole reply
    path in try/except, so this is defense-in-depth, not the only guard."""
    try:
        hint = await queries.get_latest_analysis_hint(kpi, conv_id)
        if hint is None:
            return ""
        reason = _clean_hint_text(hint.why or "")
        return persona.build_hint_block(hint.action, reason or None, lang)
    except Exception:  # a hint failure must never break the reply
        logger.warning("agent: internal hint build failed conv_id=%s", conv_id)
        return ""


async def _build_memory_block(kpi: asyncpg.Pool, conv_id: int, lang: str) -> str:
    """Fetch this conversation's per-client memory and render it as Sara's SILENT
    internal memory line (to append to the system block). Returns "" — no prompt
    change — when there is no (fresh) memory row, when the memory has nothing to
    say, or on ANY failure (caller relies on fail-soft).

    Mirrors `_build_internal_hint`'s self-contained try/except envelope so
    generate_reply is byte-for-byte unchanged for conversations without memory.
    The 90-day freshness filter lives in get_client_memory (read-time expiry)."""
    try:
        memory = await queries.get_client_memory(kpi, conv_id)
        if memory is None:
            return ""
        return persona.build_memory_block(
            lang, memory.preferred_lang, memory.preferred_girls
        )
    except Exception:  # a memory-read failure must never break the reply
        logger.warning("agent: memory block build failed conv_id=%s", conv_id)
        return ""


async def _remember_client(
    kpi: asyncpg.Pool,
    conv_id: int,
    resolved_lang: str,
    incoming_text: str,
    girls: list[queries.GirlRow],
) -> None:
    """Fail-soft side-effect: persist the per-client memory for this conversation.

    Computes the girls the CLIENT named in the incoming text (via the shared
    photo_select matcher, so it folds/matches exactly like the photo layer),
    MERGES them most-recent-first ahead of the already-stored names (dedup,
    accent/case-insensitive), and upserts together with the resolved reply
    language. Only writes when there is something to store (a lang and/or at least
    one named girl) — never creates empty rows. Wrapped in its own try/except so a
    memory-write failure NEVER breaks the reply (mirrors _build_internal_hint)."""
    try:
        named = [g.name for g in photo_select.match_named_girls(incoming_text, girls)]
        prior: list[str] = []
        existing = await queries.get_client_memory(kpi, conv_id)
        if existing is not None:
            prior = existing.preferred_girls

        # Nothing new to remember → don't create/refresh an empty row.
        if not resolved_lang and not named and not prior:
            return

        # Merge most-recent-first: newly-named girls ahead of prior ones,
        # deduped accent/case-insensitively (keep the first-seen spelling).
        merged: list[str] = []
        seen: set[str] = set()
        for name in [*named, *prior]:
            key = photo_select.fold(name).strip()
            if not key or key in seen:
                continue
            seen.add(key)
            merged.append(name)

        if not resolved_lang and not merged:
            return  # truly nothing to store

        await queries.upsert_client_memory(
            kpi, conv_id, resolved_lang or None, merged
        )
    except Exception:  # a memory write must never break the already-good reply
        logger.warning("agent: client memory write failed conv_id=%s", conv_id)


async def _build_style_block(
    kpi: asyncpg.Pool, casa_id: int, lang: str, incoming_text: str = ""
) -> str:
    """Fetch this casa's APPROVED style examples (human-receptionist replies) and
    render them as the persona's "how the team replies" style block, picking the
    ones most RELEVANT to `incoming_text` (so Sara sees how the team answered
    similar situations). Returns "" — no prompt change — when there are no approved
    examples or on ANY failure (fail-soft). Re-sanitizes every field at injection
    time (defense in depth; the harvest already scrubbed them)."""
    try:
        examples = await queries.get_approved_style_examples(
            kpi, casa_id, lang, incoming_text
        )
        if not examples:
            return ""
        pairs: list[tuple[str | None, str]] = []
        for ex in examples:
            reply = _sanitize_for_prompt(ex.reply_msg, _MAXLEN_FAQ)
            if not reply:
                continue
            client = (
                _sanitize_for_prompt(ex.client_msg or "", _MAXLEN_FAQ)
                if ex.client_msg
                else ""
            )
            pairs.append((client or None, reply))
        return persona.build_style_block(pairs, lang)
    except Exception:  # a style-block failure must never break the reply
        logger.warning("agent: style block build failed casa_id=%s", casa_id)
        return ""


_MD_ASTERISK_RE = re.compile(r"\*+")
_MD_HEADER_RE = re.compile(r"(?m)^[ \t]{0,3}#{1,6}[ \t]+")


def _strip_formatting(text: str) -> str:
    """Remove markdown the model sometimes emits — WhatsApp renders it literally
    ('**Cloe**' shows the asterisks, not bold). Strips asterisks, backticks and
    markdown headers; leaves emoji, accents and normal punctuation untouched.
    Deterministic guarantee that no '*'/'`' formatting reaches the client."""
    if not text:
        return text
    text = _MD_ASTERISK_RE.sub("", text)
    text = text.replace("`", "")
    text = _MD_HEADER_RE.sub("", text)
    return text


def _strip_client_name(text: str, client_name: str) -> str:
    """DISCRECIÓN: remove the client's OWN name from the outgoing reply.

    The system prompt already hides the name (name_ctx='desconocido') and forbids
    addressing the client by name, but Haiku can still echo a name it SEES in the
    conversation history (the client signed a message, or a pre-fix assistant turn
    used it). This is the deterministic output guard — mirrors _strip_formatting:
    whatever the model emits, the client's name never ships.

    Targets VOCATIVE uses (greeting / direct address) so it won't drop a girl's
    name used as an object. Conservative: first name token only, >=3 chars,
    whole-word, accent/case-insensitive."""
    if not text or not client_name:
        return text
    parts = client_name.strip().split()
    first = parts[0] if parts else ""
    if len(first) < 3:
        return text
    n = re.escape(first)
    out = text
    # 1) Greeting + name → keep the greeting, drop the name ("Hola Harry 😊").
    #    Note: do NOT consume the space AFTER the name (keeps "Hola claro").
    out = re.sub(r"(?i)\b(hola+|holi|buenas|hey)\b[ \t]+" + n + r"\b,?", r"\1", out)
    # 2) Vocative set off by a comma (", Harry" / "Harry,").
    out = re.sub(r"(?i),[ \t]*" + n + r"\b", "", out)
    out = re.sub(r"(?i)\b" + n + r"\b[ \t]*,", "", out)
    # 3) Name right before sentence-ending punctuation ("... Harry?" / "Harry!").
    out = re.sub(r"(?i)[ \t]+" + n + r"\b(?=[ \t]*[!?.])", "", out)
    if out == text:
        return text
    # Tidy the gaps the removal leaves.
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r"[ \t]+([,!?.;:])", r"\1", out)
    out = re.sub(r"(?m)^[ \t]*[,;:][ \t]*", "", out)
    out = re.sub(r"[ \t]+\n", "\n", out)
    return out.strip() or text


def _has_leak(reply: str) -> bool:
    """True if the reply leaks the system prompt or an API key marker."""
    lower = reply.lower()
    return any(marker in lower for marker in _LEAK_MARKERS)


def _fallback_text(lang: str) -> str:
    """Localized, varied human-sounding fallback line. Used on no-profile,
    empty/leaked LLM output, or any exception (random.choice so repeated
    errors don't look identical to the client)."""
    variants = persona.FALLBACK_VARIANTS.get(lang, persona.FALLBACK_VARIANTS[DEFAULT_LANG])
    return random.choice(variants)


async def generate_reply(
    kpi: asyncpg.Pool,
    *,
    casa_id: int,
    conv_id: int,
    incoming_text: str,
    lang: str | None = None,
    client_name: str = "",
    outcall_base_eur: int | None = None,
    outcall_taxi_eur: int | None = None,
    outcall_defer: bool = False,
    ab_variant: str | None = None,
) -> str:
    """Generate a 100%-human WhatsApp reply that CLOSES (quotes price, confirms
    bookings). Returns plain text ready to send via WAHA. Never raises for the
    caller: on any failure returns a localized human-sounding fallback line.

    F3 OUTCALL: the caller computes the price in Python and passes the result as
    CONTEXT — `outcall_base_eur` + `outcall_taxi_eur` are the exact precomputed
    breakdown (the model quotes both verbatim as "domicilio {base}€ + {taxi}€ de
    taxi", never recomputes); `outcall_defer=True` asks Sara to defer / keep
    requesting the location PIN when the price is not computable. When none is set
    (the default), the prompt is byte-for-byte unchanged.
    """
    # Resolve language as early as possible so even the fallback is localized.
    resolved_lang = lang or DEFAULT_LANG
    try:
        knowledge = await queries.get_casa_knowledge(kpi, casa_id)
        if knowledge.profile is None:
            # A casa with no profile row can't be operated by the agent.
            logger.warning("agent: no casa_profile for casa_id=%s", casa_id)
            return _fallback_text(resolved_lang)

        # Resolve the reply language. An explicit caller `lang` always wins.
        # Otherwise DETECT the client's language from their message so Sara
        # answers in their language (es/en/fr/it) instead of always the casa
        # default — detection is conservative (returns None when unsure), so an
        # ambiguous/short message falls back to the casa default, then "es".
        casa_default = knowledge.profile.default_lang or DEFAULT_LANG
        resolved_lang = lang or lang_detect.detect_lang(incoming_text) or casa_default

        system = build_system_prompt(resolved_lang, knowledge, client_name)
        # Soft hint from the analyzer (internal-only, never shown to the client).
        # Appended to the trusted system block; fail-soft to no-hint so a hint
        # failure never changes the reply for analyzed-or-not conversations.
        system += await _build_internal_hint(kpi, conv_id, resolved_lang)
        # Per-client memory (internal-only, SILENT): appended to the trusted
        # system block exactly like the hint. Fail-soft to "" so a memory failure
        # never changes the reply, and the prompt is byte-for-byte unchanged for
        # conversations without (fresh) memory.
        system += await _build_memory_block(kpi, conv_id, resolved_lang)
        # Wave 2: the casa's APPROVED human-receptionist style examples (internal-
        # only style guidance, never quoted). Fail-soft to "" so the prompt is
        # byte-for-byte unchanged for casas without approved examples.
        system += await _build_style_block(kpi, casa_id, resolved_lang, incoming_text)
        # Wave 3: A/B greeting-variant nudge for the OPENING message (the caller
        # passes the assigned bucket only on the first auto-reply). "" outside the
        # test so the prompt is byte-for-byte unchanged.
        system += persona.build_greeting_variant_block(ab_variant, resolved_lang)
        # F3 outcall context (internal-only): when the caller passed a precomputed
        # total, inject the "quote EXACTLY {total}€ verbatim" block; when it asked
        # to defer, inject the "no price yet / ask for the pin" block. Both are ""
        # absent here so the prompt is byte-for-byte unchanged for the common
        # (non-outcall) path. The number is computed in Python upstream — the model
        # only PHRASES it (CLAUDE.md: never let the LLM do arithmetic).
        if outcall_base_eur is not None:
            system += persona.build_outcall_block(
                outcall_base_eur, outcall_taxi_eur, resolved_lang
            )
        elif outcall_defer:
            system += persona.build_outcall_block(None, None, resolved_lang)
        turns = await queries.get_recent_turns(kpi, conv_id, limit=8)

        # Build the chronological turn list: sanitized prior turns + the current
        # incoming message as the final user turn. History is attacker-influenced
        # (it replays prior client messages), so every turn is sanitized exactly
        # like the live message — not just the incoming one.
        raw: list[tuple[str, str]] = [
            (t.role, _sanitize_incoming(t.content))
            for t in turns
            if t.role in ("user", "assistant")
        ]
        # The triggering message is usually already persisted (so it is the last
        # turn from get_recent_turns). Only append it when it isn't already the
        # last user turn, to avoid the client's message appearing twice.
        incoming = _sanitize_incoming(incoming_text)
        if incoming and not (raw and raw[-1] == ("user", incoming)):
            raw.append(("user", incoming))

        # Normalize for the Anthropic Messages API: drop empties, merge
        # consecutive same-role turns (clients often send several in a row), and
        # drop any leading assistant turns so the array starts with a user turn.
        norm: list[dict[str, str]] = []
        for role, content in raw:
            if not content:
                continue
            if norm and norm[-1]["role"] == role:
                norm[-1]["content"] += "\n" + content
            else:
                norm.append({"role": role, "content": content})
        while norm and norm[0]["role"] != "user":
            norm.pop(0)
        if not norm:  # nothing usable to send
            return _fallback_text(resolved_lang)

        # _call_text appends the final user turn itself, so split it off.
        *history, last = norm
        reply = await _call_text(system, last["content"], history=history)
        reply = _strip_formatting(reply)  # WhatsApp shows markdown literally
        reply = _strip_client_name(reply, client_name)  # DISCRECIÓN: nunca el nombre del cliente

        leaked = _has_leak(reply) if reply else False
        if not reply or leaked:
            logger.warning(
                "agent: reply rejected (empty=%s, leak=%s) casa_id=%s conv_id=%s",
                not reply, leaked, casa_id, conv_id,
            )
            return _fallback_text(resolved_lang)
        # SUCCESS PATH ONLY: persist the per-client memory (preferred lang + girls
        # the client named in the incoming text). Only on a clean, non-leaked,
        # non-fallback reply, so rejected/empty replies record nothing harmful.
        # Fail-soft inside the helper — this can never break the returned reply.
        # Covers BOTH auto and copilot (both flow through this single call).
        await _remember_client(
            kpi, conv_id, resolved_lang, incoming, knowledge.girls_available
        )
        return reply
    except Exception:  # isolate every failure into a safe reply
        logger.exception(
            "agent: generate_reply failed casa_id=%s conv_id=%s", casa_id, conv_id
        )
        return _fallback_text(resolved_lang)


# ── Abandoned-quote follow-up (one warm re-engagement nudge) ─────────
# Internal instruction appended to Sara's persona system prompt for the
# follow-up generation. Localized; falls back to DEFAULT_LANG. The client quoted
# a price went silent — re-open softly. Phrased in the same internal-directive
# register (UPPERCASE label) as the hint/memory blocks; covered by
# _SECURITY_BLOCK / _LEAK_MARKERS so an echoed label is discarded.
_FOLLOWUP_INSTRUCTIONS: dict[str, str] = {
    "es": (
        "\n\nSEGUIMIENTO (NUNCA lo menciones ni digas que retomas): el cliente se "
        "quedó callado después de que le dieras un precio/oferta. Escríbele UN solo "
        "mensaje corto, cálido y natural para reabrir la conversación con suavidad. "
        "Puedes recordar de pasada a la chica o la oferta. SIN presión, SIN insistir, "
        "SIN volver a pedirle el teléfono, SIN decir que eres IA. Como una chica real "
        "que retoma el hilo."
    ),
    "en": (
        "\n\nFOLLOW-UP (NEVER mention it or say you're following up): the client "
        "went quiet after you quoted a price/offer. Write ONE short, warm, natural "
        "message to softly re-open the conversation. You may lightly re-mention the "
        "girl or the offer. NO pressure, NO nagging, do NOT ask for their phone "
        "again, do NOT say you're AI. Like a real girl picking the chat back up."
    ),
    "fr": (
        "\n\nRELANCE (ne la mentionne JAMAIS et ne dis pas que tu relances): le "
        "client s'est tu après que tu lui as donné un prix/une offre. Écris UN seul "
        "message court, chaleureux et naturel pour rouvrir doucement la conversation. "
        "Tu peux rementionner la fille ou l'offre. SANS pression, SANS insister, ne "
        "redemande PAS son téléphone, ne dis PAS que tu es IA."
    ),
    "it": (
        "\n\nFOLLOW-UP (non menzionarlo MAI e non dire che stai riscrivendo): il "
        "cliente è rimasto in silenzio dopo che gli hai dato un prezzo/offerta. "
        "Scrivi UN solo messaggio corto, caldo e naturale per riaprire dolcemente la "
        "conversazione. Puoi rimenzionare la ragazza o l'offerta. SENZA pressione, "
        "SENZA insistere, NON richiedere il suo numero, NON dire che sei IA."
    ),
}


def _followup_instruction(lang: str) -> str:
    """Localized follow-up instruction appended to the system prompt."""
    return _FOLLOWUP_INSTRUCTIONS.get(lang, _FOLLOWUP_INSTRUCTIONS[DEFAULT_LANG])


async def generate_followup_text(
    kpi: asyncpg.Pool,
    *,
    casa_id: int,
    conv_id: int,
    lang: str | None = None,
    client_name: str = "",
) -> str:
    """Generate ONE warm re-engagement nudge for an abandoned quote.

    Loads the casa knowledge + last turns and builds the SAME persona system
    prompt as generate_reply, then appends a follow-up instruction asking Claude
    for a single short, human, no-pressure message that softly re-opens the chat
    after the client went silent on a quote.

    FAIL-SOFT INVERTED vs generate_reply: returns "" on no-profile, empty/leaked
    output OR any exception — the caller SKIPS the send entirely instead of ever
    sending a generic fallback nudge (an unwanted nudge is worse than none). Like
    generate_reply, it NEVER raises (reply_engine must never raise). It does NOT
    call _remember_client (a nudge learns nothing new about the client).
    """
    try:
        knowledge = await queries.get_casa_knowledge(kpi, casa_id)
        if knowledge.profile is None:
            logger.warning("agent: no casa_profile for follow-up casa_id=%s", casa_id)
            return ""

        resolved_lang = lang or knowledge.profile.default_lang or DEFAULT_LANG
        system = build_system_prompt(resolved_lang, knowledge, client_name)
        system += _followup_instruction(resolved_lang)

        # Replay the last turns (sanitized) so the nudge is in-context (it can
        # reference the girl/offer Sara just quoted). History is attacker-
        # influenced, so every turn is sanitized exactly like generate_reply.
        turns = await queries.get_recent_turns(kpi, conv_id, limit=8)
        raw: list[tuple[str, str]] = [
            (t.role, _sanitize_incoming(t.content))
            for t in turns
            if t.role in ("user", "assistant")
        ]
        norm: list[dict[str, str]] = []
        for role, content in raw:
            if not content:
                continue
            if norm and norm[-1]["role"] == role:
                norm[-1]["content"] += "\n" + content
            else:
                norm.append({"role": role, "content": content})
        while norm and norm[0]["role"] != "user":
            norm.pop(0)
        if not norm:  # no usable client turn to re-open from → skip the nudge
            return ""

        # _call_text appends the final user turn itself, so split it off. The
        # last turn here is the client's last message before they went quiet.
        *history, last = norm
        reply = await _call_text(system, last["content"], history=history)
        reply = _strip_formatting(reply)  # WhatsApp shows markdown literally
        reply = _strip_client_name(reply, client_name)  # DISCRECIÓN: nunca el nombre del cliente

        leaked = _has_leak(reply) if reply else False
        if not reply or leaked:
            logger.warning(
                "agent: follow-up rejected (empty=%s, leak=%s) casa_id=%s conv_id=%s",
                not reply, leaked, casa_id, conv_id,
            )
            return ""
        return reply
    except Exception:  # isolate every failure into a SKIP (return "")
        logger.exception(
            "agent: generate_followup_text failed casa_id=%s conv_id=%s",
            casa_id, conv_id,
        )
        return ""
