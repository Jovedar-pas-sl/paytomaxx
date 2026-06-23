"""Claude Haiku 4.5 skills for conversation analysis.

Each skill is an independent async function that takes the transcript and
returns a Pydantic model. They all use structured outputs
(`output_config.format`) so the response is guaranteed to parse.

Run them in parallel with asyncio.gather() — latency ≈ slowest call (~2-3s),
not the sum.
"""

from __future__ import annotations

import contextvars
import copy
import json
import logging
from dataclasses import dataclass
from typing import Any

from anthropic import AsyncAnthropic

from app.analyzer import prompts
from app.models import (
    EscalationResult,
    MergeDetectResult,
    RedFlag,
    RedFlagsResult,
)
from app.settings import get_settings

logger = logging.getLogger(__name__)

_client: AsyncAnthropic | None = None
MODEL = "claude-haiku-4-5"

# Per-job token accumulator. analyze_conversation_job / meta_analyze_casa_job
# wrap their work with `with token_accumulator() as acc: ...` to collect
# token usage across the 10+ skill calls they fan out, then persist it.
_TOKEN_CTX: contextvars.ContextVar[dict | None] = contextvars.ContextVar(
    "claude_tokens", default=None,
)


class token_accumulator:
    """Context manager that aggregates Claude token usage from every
    `_call_json` made inside its scope. Returns a dict {input, output, calls}
    on `__enter__`. Read it after the block to compute USD cost.

    Usage:
        with token_accumulator() as acc:
            await ...skill calls...
        cost_usd = compute_cost(acc)
    """

    def __init__(self) -> None:
        self._token = None
        self.acc: dict[str, int] = {"input": 0, "output": 0, "calls": 0}

    def __enter__(self) -> dict[str, int]:
        self._token = _TOKEN_CTX.set(self.acc)
        return self.acc

    def __exit__(self, *exc) -> None:
        if self._token is not None:
            _TOKEN_CTX.reset(self._token)


def compute_cost_usd(acc: dict[str, int]) -> float:
    """Convert {input, output, calls} → USD using settings prices."""
    s = get_settings()
    inp = acc.get("input", 0) * s.claude_price_input_per_mtok / 1_000_000
    out = acc.get("output", 0) * s.claude_price_output_per_mtok / 1_000_000
    return round(inp + out, 6)


def _get_client() -> AsyncAnthropic:
    global _client
    if _client is None:
        # max_retries=2 → SDK auto-retries on 429/5xx/connection errors with
        # exponential backoff. Kept LOW so a stuck/slow call fails fast (≈2×timeout)
        # instead of piling up minutes and tripping the outer wait_for.
        _client = AsyncAnthropic(
            api_key=get_settings().anthropic_api_key.get_secret_value(),
            max_retries=2,
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
    """Invoke Claude Haiku 4.5 and return a parsed dict via FORCED TOOL-USE.

    We define a single tool whose input_schema is the (fixed) JSON schema and
    force Claude to call it (tool_choice → that tool). The tool_use block's
    `.input` is the already-parsed, validated JSON object.

    Why tool-use and NOT output_config.format (structured outputs): the
    structured-output path runs a server-side JSON-schema COMPILER before
    answering, which was slow/timing-out (>180s) for our large nested schema
    (the block analyzer's BlockAnalysisResult). Forced tool-use does not invoke
    that compiler and is portable across SDK versions. Callers are unchanged —
    they already do Model.model_validate(data) on the returned dict.

    Per-request timeout 30s default — callers pass more for big payloads.
    """
    fixed = _fix_schema(copy.deepcopy(schema))  # deep copy — don't mutate Pydantic's cached schema
    client = _get_client()
    tool = {
        "name": "emit_result",
        "description": "Devuelve el resultado del análisis como JSON estructurado.",
        "input_schema": fixed,
    }
    response = await client.messages.create(
        model=MODEL,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
        tools=[tool],  # type: ignore[list-item]
        tool_choice={"type": "tool", "name": "emit_result"},
        timeout=timeout,
    )
    # Record token usage in the per-job accumulator if one is active.
    acc = _TOKEN_CTX.get()
    if acc is not None and response.usage is not None:
        acc["input"] += getattr(response.usage, "input_tokens", 0) or 0
        acc["output"] += getattr(response.usage, "output_tokens", 0) or 0
        acc["calls"] += 1
    if response.stop_reason == "max_tokens":
        raise RuntimeError("Claude hit max_tokens — JSON likely truncated")
    # Forced tool-use: the parsed JSON is the tool_use block's input.
    for block in response.content:
        if block.type == "tool_use" and block.name == "emit_result":
            data = block.input
            return json.loads(data) if isinstance(data, str) else data
    raise ValueError("No tool_use block in Claude response")


async def _call_text(
    system: str, user: str,
    *,
    history: list[dict] | None = None,
    temperature: float = 0.85,
    max_tokens: int = 220,
    timeout: float = 30.0,
) -> str:
    """Invoke Claude Haiku 4.5 for a free-text reply (no structured output).

    Sibling of `_call_json` for the WhatsApp reply agent: reuses the same
    `_get_client()` singleton, MODEL string and per-job token accounting, but
    drops the JSON-schema machinery and returns the concatenated text blocks.

    `history` is prepended verbatim as prior turns (already role-validated by
    the caller); `user` is appended as the final user turn. `temperature`
    defaults higher than the analyzer skills — replies need persona variety.
    """
    client = _get_client()
    messages = (history or []) + [{"role": "user", "content": user}]
    response = await client.messages.create(
        model=MODEL,
        max_tokens=max_tokens,
        temperature=temperature,
        system=system,
        messages=messages,  # type: ignore[arg-type]
        timeout=timeout,
    )
    # Record token usage in the per-job accumulator if one is active.
    acc = _TOKEN_CTX.get()
    if acc is not None and response.usage is not None:
        acc["input"] += getattr(response.usage, "input_tokens", 0) or 0
        acc["output"] += getattr(response.usage, "output_tokens", 0) or 0
        acc["calls"] += 1
    # Join every text block; a max_tokens cutoff still yields usable prose for a
    # short WhatsApp reply, so we don't raise here (unlike the JSON helper).
    parts = [b.text for b in response.content if b.type == "text"]
    return "".join(parts).strip()


# ── Live guardrail skills (red flags + escalation) ──────────────────


async def detect_red_flags(messages: list[Message]) -> list[RedFlag]:
    transcript = format_transcript(messages)
    data = await _call_json(
        system=prompts.RED_FLAGS_PROMPT,
        user=f"Transcript:\n{transcript}",
        schema=RedFlagsResult.model_json_schema(),
    )
    return RedFlagsResult.model_validate(data).flags


async def evaluate_escalation(messages: list[Message]) -> EscalationResult:
    """Binary signal whether a human admin should take over this conversation."""
    transcript = format_transcript(messages)
    data = await _call_json(
        system=prompts.ESCALATION_PROMPT,
        user=f"Transcript:\n{transcript}",
        schema=EscalationResult.model_json_schema(),
    )
    return EscalationResult.model_validate(data)


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
