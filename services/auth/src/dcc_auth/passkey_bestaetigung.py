"""Weiterer Passkey nur mit Bestätigung durch einen vorhandenen.

Security-Scan 2026-11-04: Bei Konten mit Passkey, aber ohne TOTP, genügten
Sitzung und Passwort, um einen eigenen Passkey anzuhängen. Der Angreifer
meldete sich danach dauerhaft passwortlos an, auch nachdem der Inhaber sein
Passwort geändert hatte (ein Passwortwechsel entfernt keine Passkeys).

Jetzt bestätigt der Inhaber jeden weiteren Passkey mit einem schon
eingerichteten: ``webauthn_register_options`` legt eine zweite Zeremonie
(``navigator.credentials.get``, nur die eigenen Passkeys erlaubt) samt Ticket
bei, ``webauthn_register_verify`` prüft deren Antwort hier. Wer keinen Passkey
zur Hand hat, weist sich ersatzweise mit einem Backup-Code aus.

Dieselbe Bestätigung verlangt ``totp_verify_setup``, wenn das Konto schon
Passkeys hat: sonst schaltete der Angreifer zuerst eigenes TOTP ein (und
ersetzte dabei die Backup-Codes des Inhabers), hätte damit einen Faktor in der
Hand und käme über den TOTP-Zweig an der Passkey-Schranke vorbei. Die
Zeremonie dafür holt der Klient direkt vor dem Absenden über
``POST /webauthn/bestaetigung/options`` (das QR-Scannen kann länger dauern als
die Gültigkeit eines Tickets).

Nicht hier: TOTP-Konten beim Passkey-Anlegen (dort verlangt
``webauthn_register_verify`` den TOTP- oder Backup-Code) und Konten ohne
Passkey (es gibt noch keinen Faktor, mit dem man bestätigen könnte; wie beim
Einrichten von TOTP reicht das Passwort).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any

import jwt
import structlog
import webauthn
from fastapi import APIRouter, Depends, HTTPException, Request, status
from webauthn.helpers import base64url_to_bytes

from dcc_auth.config import Settings, get_settings
from dcc_auth.db import SessionDep
from dcc_auth.models import User, WebAuthnCredential
from dcc_auth.passkeys import (
    PURPOSE_CONFIRM,
    build_authentication_options,
    decode_challenge_ticket,
    issue_challenge_ticket,
    load_user_credentials,
)
from dcc_auth.recovery import SingleUseNichtPruefbar, claim_ticket_jti
from dcc_auth.routes import _check_account_rate, _check_rate, _get_current_user, _signer_dep
from dcc_auth.schemas import PasskeyBestaetigungOut
from dcc_auth.security import JwtSigner

router = APIRouter()
log = structlog.get_logger(__name__)


def _abgelehnt(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, detail=detail)


def bestaetigung_anbieten(
    settings: Settings,
    signer: JwtSigner,
    *,
    user_id: int,
    vorhandene: list[WebAuthnCredential],
) -> tuple[dict | None, str | None]:
    """``(options, ticket)`` der Bestätigungs-Zeremonie, ``(None, None)`` ohne Passkeys."""
    if not vorhandene:
        return None, None
    options, challenge = build_authentication_options(settings, allow=vorhandene)
    ticket = issue_challenge_ticket(
        signer,
        purpose=PURPOSE_CONFIRM,
        challenge=challenge,
        user_id=user_id,
        ttl_seconds=settings.webauthn_challenge_ttl_seconds,
    )
    return options, ticket


@router.post("/webauthn/bestaetigung/options", response_model=PasskeyBestaetigungOut)
async def bestaetigung_options(
    request: Request,
    session: SessionDep,
    current: Annotated[User, Depends(_get_current_user)],
    signer: Annotated[JwtSigner, Depends(_signer_dep)],
):
    """Bestätigungs-Zeremonie für ``totp_verify_setup``; ohne Passkeys beide Felder ``None``."""
    settings = get_settings()
    await _check_rate(request, "webauthn_register", settings.rate_limit_webauthn_register)
    options, ticket = bestaetigung_anbieten(
        settings,
        signer,
        user_id=current.id,
        vorhandene=await load_user_credentials(session, current.id),
    )
    return PasskeyBestaetigungOut(bestaetigung_options=options, bestaetigung_ticket=ticket)


async def bestaetigung_pruefen(
    session,
    request: Request,
    signer: JwtSigner,
    current: User,
    *,
    backup_code: str | None,
    bestaetigung: dict[str, Any] | None,
    bestaetigung_ticket: str | None,
) -> None:
    """Wirft 401, wenn ein Konto mit Passkeys ohne gültige Bestätigung kommt.

    Ein verbrauchter Backup-Code und der neue Zählerstand des bestätigenden
    Passkeys landen in ``session``; der Aufrufer committet.
    """
    vorhandene = await load_user_credentials(session, current.id)
    if not vorhandene:
        return
    settings = get_settings()

    if backup_code:
        # Je-Konto-Bremse wie bei TOTP-Konten, sonst grindet ein verteilter
        # Angreifer die Backup-Codes.
        await _check_account_rate(request, "webauthn_register", str(current.id))
        from dcc_auth.routes_totp import _consume_second_factor  # noqa: PLC0415

        if not await _consume_second_factor(
            session, current, code=None, backup_code=backup_code
        ):
            raise _abgelehnt("invalid code")
        return

    if not (bestaetigung and bestaetigung_ticket):
        raise _abgelehnt("passkey_confirmation_required")
    try:
        challenge, ticket_user_id, jti = decode_challenge_ticket(
            signer, bestaetigung_ticket, expected_purpose=PURPOSE_CONFIRM
        )
    except jwt.PyJWTError as exc:
        raise _abgelehnt("invalid or expired confirmation") from exc
    if ticket_user_id != current.id:
        raise _abgelehnt("invalid or expired confirmation")

    # Nur ein Passkey DIESES Kontos bestätigt; ein fremder (auch ein eigener
    # des Angreifers) ist nicht in ``vorhandene``.
    raw_id = str(bestaetigung.get("id") or bestaetigung.get("rawId") or "")
    row = next((c for c in vorhandene if c.credential_id == raw_id), None)
    if row is None:
        raise _abgelehnt("passkey does not match account")
    try:
        verified = webauthn.verify_authentication_response(
            credential=bestaetigung,
            expected_challenge=challenge,
            expected_rp_id=settings.webauthn_rp_id,
            expected_origin=settings.webauthn_origins_list,
            credential_public_key=base64url_to_bytes(row.public_key),
            credential_current_sign_count=row.sign_count,
            require_user_verification=False,
        )
    except Exception as exc:  # noqa: BLE001 — webauthn raises a wide hierarchy
        log.warning("passkey_bestaetigung_failed", user_id=current.id, error=str(exc))
        raise _abgelehnt("passkey verification failed") from exc

    # Einmal-Ticket wie im Login-Pfad: erst nach geprüfter Antwort verbrennen,
    # fail-closed, wenn Redis nicht antwortet.
    try:
        frisch = await claim_ticket_jti(
            settings.redis_url,
            "webauthn:challenge:used:",
            jti,
            settings.webauthn_challenge_ttl_seconds,
        )
    except SingleUseNichtPruefbar as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="single-use store unavailable"
        ) from exc
    if not frisch:
        raise _abgelehnt("invalid or expired confirmation")
    row.sign_count = verified.new_sign_count
    row.last_used_at = datetime.now(UTC)
