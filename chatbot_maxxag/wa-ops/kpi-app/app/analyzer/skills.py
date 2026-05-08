"""Claude Haiku 4.5 skills for conversation analysis.

Each skill is an independent async function that takes the transcript and
returns a Pydantic model. They all use structured outputs
(`output_config.format`) so the response is guaranteed to parse.

Run them in parallel with asyncio.gather() — latency ≈ slowest call (~2-3s),
not the sum.
"""

from __future__ import annotations

import copy
import json
import logging
from dataclasses import dataclass
from typing import Any

from anthropic import AsyncAnthropic

from app.analyzer import prompts
from app.models import (
    CoachingResult,
    ConversionResult,
    EscalationResult,
    IntentResult,
    MergeDetectResult,
    MoodResult,
    NextActionResult,
    RedFlag,
    RedFlagsResult,
    ReferralResult,
    ResponseTimeResult,
    TreatmentResult,
)
from app.settings import get_settings

logger = logging.getLogger(__name__)

_client: AsyncAnthropic | None = None
MODEL = "claude-haiku-4-5"


def _get_client() -> AsyncAnthropic:
    global _client
    if _client is None:
        # max_retries=4 → SDK auto-retries on 429 (rate limit), 5xx, connection
        # errors with exponential backoff. Combined with our 30s per-request
        # timeout this gives ~120s worst case before we fail a single skill,
        # which is then caught by analyze_conversation_job's gather(return_exceptions).
        _client = AsyncAnthropic(
            api_key=get_settings().anthropic_api_key.get_secret_value(),
            max_retries=4,
        )
    return _client


@dataclass
class Message:
    ts: int                # unix seconds
    role: str              # "cliente" | "mamai"
    content: str


def format_transcript(messages: list[Message]) -> str:
    """Format messages as a simple transcript for Claude prompts."""
    lines: list[str] = []
    for m in messages:
        prefix = "CLIENTE" if m.role == "cliente" else "MAMAI"
        lines.append(f"[{m.ts}] {prefix}: {m.content}")
    return "\n".join(lines)


def _fix_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Recursively enforce Anthropic structured-output requirements.

    - Every object needs `additionalProperties: false`
    - Numeric constraints (`minimum`/`maximum`/`minLength`/`maxLength`) are
      stripped (Anthropic rejects them on nested objects; client-side
      Pydantic validation still applies after parsing)
    """
    if isinstance(schema, dict):
        if schema.get("type") == "object":
            schema["additionalProperties"] = False
        for key in ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
                    "minLength", "maxLength", "minItems", "maxItems"):
            schema.pop(key, None)
        for v in schema.values():
            _fix_schema(v) if isinstance(v, (dict, list)) else None
    elif isinstance(schema, list):
        for item in schema:
            _fix_schema(item) if isinstance(item, (dict, list)) else None
    return schema


async def _call_json(
    system: str, user: str, schema: dict[str, Any],
    *, max_tokens: int = 2000, timeout: float = 30.0,
) -> dict[str, Any]:
    """Invoke Claude Haiku 4.5 with structured JSON output and return the parsed dict.

    Default max_tokens=800 covers the small per-skill JSON (mood, treat, etc.).
    The meta-analysis output is much larger (summary + 3-6 patterns + 3-5
    strengths + 3-5 improvements + client_profile + topics + referrals) and
    needs ~3000+ tokens — pass it explicitly from the caller.

    Per-request timeout 30s default — meta passes 60s for the bigger payload.
    Without this the SDK default is 10min, which blocks the whole bulk job
    when one call gets stuck.
    """
    fixed = _fix_schema(copy.deepcopy(schema))  # deep copy — don't mutate Pydantic's cached schema
    client = _get_client()
    response = await client.messages.create(
        model=MODEL,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
        output_config={"format": {"type": "json_schema", "schema": fixed}},  # type: ignore[arg-type]
        timeout=timeout,
    )
    if response.stop_reason == "max_tokens":
        raise RuntimeError("Claude hit max_tokens — JSON likely truncated")
    # The parsed JSON arrives in the first text block
    for block in response.content:
        if block.type == "text":
            return json.loads(block.text)
    raise ValueError("No text block in Claude response")


# ── 5 skills ──────────────────────────────────────────────────────
async def analyze_mood(messages: list[Message]) -> MoodResult:
    transcript = format_transcript(messages)
    data = await _call_json(
        system=prompts.MOOD_PROMPT,
        user=f"Transcript:\n{transcript}",
        schema=MoodResult.model_json_schema(),
    )
    return MoodResult.model_validate(data)


async def analyze_response_time(messages: list[Message]) -> ResponseTimeResult:
    # For response time, LLM is overkill — compute it deterministically.
    # Claude is only useful if timestamps aren't reliable; our DB gives us them.
    deltas_ms: list[int] = []
    pending_cliente_ts: int | None = None
    for m in messages:
        if m.role == "cliente":
            pending_cliente_ts = m.ts
        elif m.role == "mamai" and pending_cliente_ts is not None:
            deltas_ms.append((m.ts - pending_cliente_ts) * 1000)
            pending_cliente_ts = None
    if not deltas_ms:
        return ResponseTimeResult(p50_ms=0, p90_ms=0, max_ms=0)
    deltas_ms.sort()
    n = len(deltas_ms)
    p50 = deltas_ms[n // 2]
    p90 = deltas_ms[min(int(n * 0.9), n - 1)]
    return ResponseTimeResult(p50_ms=p50, p90_ms=p90, max_ms=deltas_ms[-1])


async def analyze_treatment(messages: list[Message]) -> TreatmentResult:
    transcript = format_transcript(messages)
    data = await _call_json(
        system=prompts.TREATMENT_PROMPT,
        user=f"Transcript:\n{transcript}",
        schema=TreatmentResult.model_json_schema(),
    )
    return TreatmentResult.model_validate(data)


async def analyze_conversion_intent(messages: list[Message]) -> ConversionResult:
    transcript = format_transcript(messages)
    data = await _call_json(
        system=prompts.CONVERSION_PROMPT,
        user=f"Transcript:\n{transcript}",
        schema=ConversionResult.model_json_schema(),
    )
    return ConversionResult.model_validate(data)


async def detect_red_flags(messages: list[Message]) -> list[RedFlag]:
    transcript = format_transcript(messages)
    data = await _call_json(
        system=prompts.RED_FLAGS_PROMPT,
        user=f"Transcript:\n{transcript}",
        schema=RedFlagsResult.model_json_schema(),
    )
    return RedFlagsResult.model_validate(data).flags


async def analyze_coaching(messages: list[Message]) -> CoachingResult:
    """Generate concrete, actionable advice to improve this specific type
    of conversation in the future — citing literal moments from the chat."""
    transcript = format_transcript(messages)
    data = await _call_json(
        system=prompts.COACHING_PROMPT,
        user=f"Transcript:\n{transcript}",
        schema=CoachingResult.model_json_schema(),
    )
    return CoachingResult.model_validate(data)


async def classify_intent(messages: list[Message]) -> IntentResult:
    """Classify the client's primary intention in this conversation."""
    transcript = format_transcript(messages)
    data = await _call_json(
        system=prompts.INTENT_PROMPT,
        user=f"Transcript:\n{transcript}",
        schema=IntentResult.model_json_schema(),
    )
    return IntentResult.model_validate(data)


async def recommend_next_action(messages: list[Message]) -> NextActionResult:
    """Concrete next step the operator should take NOW (urgency + suggested message)."""
    transcript = format_transcript(messages)
    data = await _call_json(
        system=prompts.NEXT_ACTION_PROMPT,
        user=f"Transcript:\n{transcript}",
        schema=NextActionResult.model_json_schema(),
    )
    return NextActionResult.model_validate(data)


async def evaluate_escalation(messages: list[Message]) -> EscalationResult:
    """Binary signal whether a human admin should take over this conversation."""
    transcript = format_transcript(messages)
    data = await _call_json(
        system=prompts.ESCALATION_PROMPT,
        user=f"Transcript:\n{transcript}",
        schema=EscalationResult.model_json_schema(),
    )
    return EscalationResult.model_validate(data)


async def detect_referral(messages: list[Message]) -> ReferralResult:
    """Identify where the client came from (ad site, search, social, repeat, etc.).

    Used downstream by the per-WA meta-analysis to compute referral source
    distribution — which marketing channels actually convert.
    """
    transcript = format_transcript(messages)
    data = await _call_json(
        system=prompts.REFERRAL_PROMPT,
        user=f"Transcript:\n{transcript}",
        schema=ReferralResult.model_json_schema(),
    )
    return ReferralResult.model_validate(data)


@dataclass
class SiblingConvo:
    conv_id: int
    label: str          # display name (contact name / phone / jid)
    messages: list[Message]


async def detect_same_client(
    target_messages: list[Message],
    target_label: str,
    candidates: list[SiblingConvo],
) -> MergeDetectResult:
    """Ask Claude which candidate conversation is most likely the SAME client
    as the target (typical case: @lid + @c.us split by WhatsApp privacy)."""
    if not candidates:
        return MergeDetectResult(best_match_id=None, confidence=0.0,
                                 reasoning="No hay conversaciones candidatas")

    # Build a compact user prompt: target + each candidate with its messages
    lines: list[str] = []
    lines.append(f"=== TARGET: {target_label} ===")
    lines.append(format_transcript(target_messages[:25]))
    lines.append("")
    lines.append("=== CANDIDATES ===")
    for c in candidates[:8]:  # cap at 8 for prompt size
        lines.append(f"--- conv_id={c.conv_id} | {c.label} ---")
        lines.append(format_transcript(c.messages[:15]))
        lines.append("")

    data = await _call_json(
        system=prompts.MERGE_DETECT_PROMPT,
        user="\n".join(lines),
        schema=MergeDetectResult.model_json_schema(),
    )
    return MergeDetectResult.model_validate(data)
