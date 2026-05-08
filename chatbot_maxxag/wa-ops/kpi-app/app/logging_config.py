"""Structured logging setup with structlog + request_id context.

Outputs JSON to stdout (Docker logs aggregator picks them up). Each log
event includes a `request_id` (set by middleware) so a single failure can
be traced across webhook → DB → arq → Claude → response.

Configured idempotently — calling `configure_logging()` multiple times is
safe. The plain `logging.getLogger(...)` calls existing throughout the
codebase still work; structlog wraps stdlib so we don't have to rewrite them.
"""

from __future__ import annotations

import logging
import sys
import uuid
from contextvars import ContextVar

import structlog

# Per-request correlation id. Webhook handlers / route deps set it; all
# downstream log calls automatically pick it up via the structlog processor.
request_id_var: ContextVar[str] = ContextVar("request_id", default="-")


def _add_request_id(_, __, event_dict: dict) -> dict:
    """structlog processor: attach the contextvar value to each event."""
    event_dict["request_id"] = request_id_var.get()
    return event_dict


def configure_logging(level: str = "INFO") -> None:
    """Idempotent — replaces the handler config so re-imports don't double up."""
    timestamper = structlog.processors.TimeStamper(fmt="iso", utc=True)

    shared_processors = [
        structlog.contextvars.merge_contextvars,
        _add_request_id,
        structlog.processors.add_log_level,
        timestamper,
    ]

    structlog.configure(
        processors=[
            *shared_processors,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    # Stdlib bridge: stdlib loggers (incl. uvicorn, asyncpg, httpx) get the
    # same structured JSON format.
    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=shared_processors,
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.JSONRenderer(),
        ],
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    # Replace existing handlers (idempotent)
    for h in list(root.handlers):
        root.removeHandler(h)
    root.addHandler(handler)
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    # Silence noisy libraries that flood logs at DEBUG
    for noisy in ("httpx", "httpcore", "uvicorn.access"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def new_request_id() -> str:
    """Short, URL-safe request ID (8 hex chars)."""
    return uuid.uuid4().hex[:8]
