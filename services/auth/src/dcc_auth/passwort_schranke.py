"""Passwort-Schranke für die heiklen Heimserver-Routen (Sicherheitsfund 2026-11-04).

Die Instanz-Routen authentifizieren allein über das Sitzungs-Cookie. Zwei davon
wirken auf einen laufenden Server: die Neuausstellung des Bootstrap-Tokens nach
dem Einlösen (rotiert dessen Zugangsdaten, der alte Server ist sofort draußen)
und das Löschen. Ein gestohlenes Cookie allein darf beides nicht — wie beim
Abschalten der Zwei-Faktor-Anmeldung (``routes_totp.totp_disable``) muss der
Aufrufer zusätzlich das Kontopasswort nennen.

Je-Konto-Bremse VOR der Prüfung (``rate_limit_per_account``): wer ein Cookie
erbeutet hat, soll das Passwort damit nicht durchprobieren können. Die Bremse
zählt auch Versuche ohne Passwort; das hält die Regel einfach und kostet einen
ehrlichen Nutzer nichts.
"""

from __future__ import annotations

import asyncio
from typing import Annotated

from fastapi import HTTPException, Request, status
from pydantic import BaseModel, Field

from dcc_auth.models import User
from dcc_auth.routes import _check_account_rate
from dcc_auth.security import verify_password

# Wie ``schemas._CurrentPasswordField``, aber optional: ein fehlendes Passwort
# soll als 401 ankommen (alte Server-App, alte Web-App), nicht als 422.
OptionalesPasswort = Annotated[str | None, Field(min_length=1, max_length=128)]


class PasswortIn(BaseModel):
    """Körper von ``DELETE /me/instances/{id}``."""

    password: OptionalesPasswort = None


async def passwort_bestaetigen(
    request: Request, user: User, password: str | None, *, zweck: str
) -> None:
    """401 ``invalid credentials`` ohne oder mit falschem Passwort, 429 über der
    Je-Konto-Bremse. ``zweck`` trennt die Bremsen der Routen voneinander."""
    await _check_account_rate(request, zweck, str(user.id))
    # argon2 ist CPU-lastig — aus der Ereignisschleife heraus.
    if not password or not await asyncio.to_thread(
        verify_password, password, user.password_hash
    ):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")
