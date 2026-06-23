"""Pydantic DTOs used across routes and analyzer."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

MoodLabel = Literal["curioso", "decidido", "indeciso", "enfadado", "calenton", "timewaster"]


Role = Literal["super_admin", "admin", "agent"]


class AdminUser(BaseModel):
    """An authenticated user. Backed by the `admin_user` table (migration 0018)."""

    email: str
    id: int | None = None          # None only for a legacy token issued pre-0018
    name: str | None = None
    role: Role = "agent"
    active: bool = True

    @property
    def display_name(self) -> str:
        """What we show in the UI / audit log for this user."""
        return self.name or self.email

    @property
    def is_super_admin(self) -> bool:
        return self.role == "super_admin"

    @property
    def is_admin(self) -> bool:
        """Admin-level access (admin OR super_admin)."""
        return self.role in ("admin", "super_admin")


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


# ── Block analysis (transcripts → informe in ONE Claude call) ───────
class BlockTopicShare(BaseModel):
    """One topic + how often it appears across the analyzed transcripts."""
    topic: str
    count: int = 0
    pct: float = 0.0


class BlockReferralShare(BaseModel):
    """Distribution of referral sources across the analyzed transcripts."""
    source: str
    count: int = 0
    pct: float = 0.0


class BlockRedFlag(BaseModel):
    """A red flag detected while reading the transcripts directly."""
    type: Literal["menor", "fraude", "insulto", "acoso", "timewaster"]
    reason: str


# ── Money KPIs (Entrega 2) — aggregated by the IA over the same batch ──
class BlockFunnel(BaseModel):
    """4-step funnel counts over the analyzed set."""
    escriben: int = 0        # wrote at all
    preguntan_precio: int = 0  # asked the price
    negocian_hora: int = 0   # negotiated a time/slot
    cierran: int = 0         # closed (verbal commit)


class BlockLostReason(BaseModel):
    """Why a non-closer fell off."""
    reason: str              # precio|lento|seco|solo_fotos|sin_hueco|no_estaba_chica|timewaster|otro
    count: int = 0


class BlockChicaDemand(BaseModel):
    """A chica named/asked for by clients + how many of those closed."""
    name: str
    count: int = 0
    closed: int = 0


class BlockServiceDemand(BaseModel):
    """A service requested by clients."""
    service: str             # 1h|30min|masaje|duo|desplazamiento/hotel|otro
    count: int = 0


class BlockChannelRoi(BaseModel):
    """Per ad-site/channel: how many contacts came and how many CLOSED."""
    source: str
    contacts: int = 0
    closed: int = 0


class BlockAnalysisResult(BaseModel):
    """Output of the block analyzer: a casa/number informe built by reading
    conversation transcripts directly in ONE batch Claude call."""
    summary: str = Field(default="", max_length=400)
    strengths: list[str] = Field(default_factory=list, max_length=8)
    improvements: list[str] = Field(default_factory=list, max_length=8)
    client_profile: str = Field(default="", max_length=2000)
    top_topics: list[BlockTopicShare] = Field(default_factory=list, max_length=5)
    top_referrals: list[BlockReferralShare] = Field(default_factory=list, max_length=5)
    red_flags: list[BlockRedFlag] = Field(default_factory=list, max_length=20)
    # ── Money KPIs (Entrega 2) — all OPTIONAL so old saved informes decode ──
    funnel: BlockFunnel = Field(default_factory=BlockFunnel)
    confirmed_bookings: int = 0
    confirmed_rate_pct: int = 0           # cierran / escriben * 100 (IA computes)
    estimated_revenue_eur: float = 0.0    # float so a decimal price (75.5€) never breaks validation
    revenue_is_estimate: bool = True
    lost_reasons: list[BlockLostReason] = Field(default_factory=list, max_length=8)
    top_chicas: list[BlockChicaDemand] = Field(default_factory=list, max_length=10)
    top_services: list[BlockServiceDemand] = Field(default_factory=list, max_length=8)
    upsell_count: int = 0
    upsell_pct: int = 0
    channel_roi: list[BlockChannelRoi] = Field(default_factory=list, max_length=10)


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
    # Honest first-response metric: MEDIAN time-to-first-response (seconds) over
    # conversations whose first client message landed in the last 24h, plus the
    # share answered in under 5 minutes. avg_response_time_min is kept for
    # backward-compat but is no longer the headline.
    median_first_response_seconds: int
    pct_answered_under_5min: float
    avg_response_time_min: float
    # AVG of analysis.conv_probability — an IA *guess*, not confirmed bookings.
    avg_conversion_rate: float
    # Conversations today whose last message is from the client (awaiting reply).
    unanswered_today: int
    # De-noised critical alert count (severity='critical' / actionable types,
    # unacknowledged). NOT the raw alert total.
    active_alerts: int
    online_instances: int
    total_instances: int
