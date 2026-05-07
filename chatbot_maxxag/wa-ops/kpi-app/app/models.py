"""Pydantic DTOs used across routes and analyzer."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

MoodLabel = Literal["curioso", "decidido", "indeciso", "enfadado", "calenton", "timewaster"]


class AdminUser(BaseModel):
    email: str


# ── Analyzer DTOs (match kpi.analysis table) ───────────────────────
class MoodResult(BaseModel):
    label: MoodLabel
    score: int = Field(ge=1, le=10)
    reasoning: str


class ResponseTimeResult(BaseModel):
    p50_ms: int
    p90_ms: int
    max_ms: int


class TreatmentResult(BaseModel):
    carinoso: int = Field(ge=0, le=10)
    profesional: int = Field(ge=0, le=10)
    vendedor: int = Field(ge=0, le=10)
    seco: int = Field(ge=0, le=10)


class ConversionResult(BaseModel):
    probability: float = Field(ge=0.0, le=1.0)


class RedFlag(BaseModel):
    type: Literal["menor", "insulto", "fraude", "timewaster", "acoso"]
    reason: str


class RedFlagsResult(BaseModel):
    flags: list[RedFlag]


class MissedOpportunity(BaseModel):
    moment: str      # short verbatim quote from the client
    suggestion: str  # what the mamai should have said/done


class CoachingResult(BaseModel):
    """Per-conversation coaching — how to improve next time."""
    overall: str
    went_well: list[str]
    missed_opportunities: list[MissedOpportunity]
    response_tips: list[str]
    tone_tips: list[str]
    example_reply: str


class MergeDetectResult(BaseModel):
    """Detects whether a sibling conversation is the same client as target."""
    best_match_id: int | None
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: str


# ── New skills (migration 0008) ────────────────────────────────────
IntentType = Literal[
    "cotizacion",    # preguntando precios / tarifas
    "booking",       # reservando concreto (hora + persona)
    "informacion",   # preguntando servicios / ubicación / horarios
    "queja",         # insatisfacción, reclamación
    "chit_chat",     # conversación sin intención comercial clara
    "spam",          # bot / tiempo perdido
    "otro",
]


class IntentResult(BaseModel):
    """Classifies the client's primary intention in this conversation."""
    primary: IntentType
    secondary: list[IntentType] = Field(default_factory=list)  # 0-2 adicionales
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: str


ActionType = Literal[
    "send_price",         # mandar tarifa
    "ask_availability",   # preguntar franja / día
    "send_photos",        # enviar fotos de chicas
    "close_booking",      # confirmar reserva concreta
    "ask_location",       # pedir ubicación / hotel
    "send_location",      # mandar mapa de la casa
    "follow_up",          # recordatorio a cliente inactivo
    "escalate_human",     # admin debe tomar el relevo
    "ignore_spam",        # no responder
    "none",               # no hay acción inmediata clara
]


class NextActionResult(BaseModel):
    """Concrete next step the operator should take NOW (not next time)."""
    action: ActionType
    urgency: Literal["high", "medium", "low"]
    suggested_message: str          # texto literal propuesto (vacío si "none" / "ignore_spam" / "escalate_human")
    why: str                        # breve justificación (por qué esta acción)


class EscalationResult(BaseModel):
    """Binary signal: should a human admin take over this conversation?"""
    should_escalate: bool
    severity: Literal["none", "low", "medium", "high"]
    reason: str | None              # null si should_escalate=false
    triggers: list[str] = Field(default_factory=list)  # señales detectadas


class ReferralResult(BaseModel):
    """Where the client came from (which ad site, search engine, etc.)."""
    source_kind: Literal[
        "ad_site",
        "search_engine",
        "social",
        "word_of_mouth",
        "repeat",
        "unknown",
    ]
    source_name: str | None         # ej: "Loquosex", "Google", null si no se identifica
    evidence: str | None            # cita textual breve del cliente, null si no hay
    confidence: float               # 0.0-1.0


# ── Aggregate analysis ─────────────────────────────────────────────
class ConversationAnalysis(BaseModel):
    conversation_id: int
    account_id: int
    inbox_id: int
    analyzed_at: datetime
    mood: MoodResult
    response_time: ResponseTimeResult
    treatment: TreatmentResult
    conversion: ConversionResult
    red_flags: list[RedFlag]
    claude_cost_usd: float = 0.0
    claude_tokens_in: int = 0
    claude_tokens_out: int = 0


# ── KPI DTOs ───────────────────────────────────────────────────────
class DashboardKpis(BaseModel):
    total_conversations_today: int
    total_messages_today: int
    avg_response_time_min: float
    avg_conversion_rate: float
    active_alerts: int
    online_instances: int
    total_instances: int
