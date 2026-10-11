"""422-Protokoll: jeder abgewiesene Rumpf landet geschwärzt im Container-Log."""

from __future__ import annotations

import json

import structlog
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

# Field-name blacklist for the 422 raw-body echo. Any key matching
# one of these (case-insensitive, substring) gets redacted from
# the logged payload so a future endpoint that carries a real
# secret in the body doesn't leak it via the 422 path.
_REDACT_KEY_SUBSTR = (
    "token",
    "secret",
    "password",
    "passwd",
    "key",
    "auth",
    "session",
    "cookie",
    "bearer",
    "csrf",
    "pin",
    "otp",
    "2fa",
    "mfa",
    "recovery",
    "credential",
    "private",
)


def _redact(obj):
    """Recursive redactor for the 422 raw-body echo. Module-level
    so tests can import it directly (the handler itself is
    closure-captured inside ``registriere_422_log``)."""
    if isinstance(obj, dict):
        return {
            k: ("[redacted]" if any(s in k.lower() for s in _REDACT_KEY_SUBSTR) else _redact(v))
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [_redact(v) for v in obj]
    return obj


def registriere_422_log(app: FastAPI) -> None:
    """Validation-error log: every 422 carries away the offending body
    so a future bug report can read it from the container log without
    reproducing. Bound to 1 KiB to avoid log floods from abusive
    clients; the FastAPI ``RequestValidationError`` fires before the
    route handler runs, so we still see the unmodified raw payload."""

    @app.exception_handler(RequestValidationError)
    async def _log_422(request, exc: RequestValidationError):
        try:
            raw = (await request.body()).decode(errors="replace")[:1024]
        except Exception:  # noqa: BLE001
            raw = "<unreadable>"
        # Try to redact sensitive fields before logging. The body
        # might not be JSON (e.g. multipart upload-url cancel) — dann
        # landen nur Länge und Kennung im Log (s. unten), nie der Rumpf.
        logged_body: str | dict | list
        try:
            parsed = json.loads(raw)
            logged_body = _redact(parsed)
        except Exception:  # noqa: BLE001 — not JSON, keep raw
            # Bughunt Runde 33: Nicht-JSON nie roh echoen — das ist
            # kuenftig form-encoded Passwort-/Code-Sendepfad (und jeder
            # unauthentifizierte Klient konnte beliebige Bytes ins Log
            # druecken). Nur Laenge + sichere Kennung loggen.
            logged_body = f"<non-json {len(raw)} bytes>"

        errors = json.loads(json.dumps(exc.errors(), default=str))
        structlog.get_logger("dcc_chat_gateway").warning(
            "request_validation_error",
            method=request.method,
            path=request.url.path,
            errors=errors[:6],
            raw_body=logged_body,
        )
        # Dieselbe Form wie FastAPIs eigener 422-Handler: ``{"detail": [...]}``.
        return JSONResponse(status_code=422, content={"detail": errors})
