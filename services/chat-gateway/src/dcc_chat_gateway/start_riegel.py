"""Fail-fast-Prüfungen, die die Lifespan des chat-gateway vor allem anderen fährt."""

from __future__ import annotations

import logging
from urllib.parse import urlsplit

# Logger-Name von ``app.py`` beibehalten: jede Zeile trägt ihn (``%(name)s`` im
# Format von ``dcc_shared.logging_setup``), wer danach sucht, findet sie weiter.
log = logging.getLogger("dcc_chat_gateway.app")

# MinIO default credentials are well-known (ship in the dev compose + .env.example)
# — running them against a NON-LOCAL S3 endpoint lets anyone read/write the
# attachments bucket. Local dev (endpoint on localhost) stays allowed + warns.
_MINIO_DEFAULT_KEY = "minioadmin"
_LOCAL_S3_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "host.docker.internal"})


def _s3_endpoint_is_local(url: str) -> bool:
    """True wenn der S3-Endpoint auf einen lokalen Host zeigt (Dev-Setup)."""
    return (urlsplit(url).hostname or "") in _LOCAL_S3_HOSTS


def _enforce_s3_secret_guard(settings) -> None:  # noqa: ANN001
    """Fail-fast bei MinIO-Default-Credentials gegen einen nicht-lokalen Endpoint.

    ``minioadmin/minioadmin`` ist öffentlich bekannt (steht im dev-compose +
    .env.example) — wer damit gegen ein NICHT lokales MinIO/S3 startet, erlaubt
    jedem Lese-/Schreibzugriff auf den Attachments-Bucket. Lokales Dev (Endpoint
    auf localhost) bleibt erlaubt und warnt nur. Analog zum LiveKit-devkey-Guard
    in voice-signaling.
    """
    dev_creds = _MINIO_DEFAULT_KEY in (settings.s3_access_key, settings.s3_secret_key)
    if not dev_creds:
        return
    local = _s3_endpoint_is_local(settings.s3_internal_endpoint) and _s3_endpoint_is_local(
        settings.s3_public_endpoint
    )
    if local:
        log.warning(
            "using MinIO default credentials (minioadmin) — "
            "set S3_ACCESS_KEY/S3_SECRET_KEY in production"
        )
        return
    raise RuntimeError(
        "MinIO default credentials (minioadmin/minioadmin) with a non-local S3 "
        f"endpoint (internal={settings.s3_internal_endpoint!r}, "
        f"public={settings.s3_public_endpoint!r}) — anyone could read/write the "
        "attachments bucket. Set S3_ACCESS_KEY/S3_SECRET_KEY."
    )


async def pruefe_startbedingungen(settings, *, skip_redis: bool) -> None:  # noqa: ANN001
    """Die vier Startverweigerungen, in der Reihenfolge, in der die Lifespan sie fährt."""
    # Fail fast: a self-host must have PULSE_INSTANCE_ID set to a non-zero value.
    # Without it every instance would compute the same pairwise-subs (DE 11 A.13).
    # Skip in test mode (skip_redis=True) so unit tests with default settings pass.
    if (
        not skip_redis
        and settings.pulse_instance_mode == "self-host"
        and settings.pulse_instance_id == 0
    ):
        raise RuntimeError(
            "PULSE_INSTANCE_ID must be set to a non-zero value on a self-host. "
            "Set PULSE_INSTANCE_ID in your .env file to the Snowflake-ID assigned "
            "by the Cloud at approval time."
        )
    # Fail-fast: Daten aus der Pseudonym-Zeit. Ein Self-Host aktualisiert sich
    # unbeaufsichtigt alle fuenf Minuten; ohne diesen Riegel liefe er nach dem
    # Update still halb kaputt an. Details in ``altbestand_riegel``.
    if not skip_redis and settings.pulse_instance_mode == "self-host":
        from dcc_chat_gateway.altbestand_riegel import pruefe_altbestand
        from dcc_chat_gateway.db import SessionLocal

        await pruefe_altbestand(SessionLocal)
    # Fail-fast: der .env.example-Platzhalter ist öffentlich bekannt — damit zu
    # starten hieße, die internen Service-zu-Service-Endpoints mit einem
    # allgemein bekannten "Secret" zu schützen. Leer = deaktiviert, ok.
    if settings.internal_service_secret == "__CHANGE_ME__":
        raise RuntimeError(
            "INTERNAL_SERVICE_SECRET is still the .env.example placeholder __CHANGE_ME__ — "
            "set a real secret (same value on auth-svc/voice-signaling) or leave it unset."
        )
    # Fail-fast: MinIO-Default-Credentials gegen einen nicht-lokalen S3-Endpoint.
    _enforce_s3_secret_guard(settings)
