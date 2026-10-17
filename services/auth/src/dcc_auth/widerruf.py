"""Was ein Widerruf einem noch gültigen Zugriffstoken lässt.

**Die Lücke (bis 2026-10-17).** Ein Zugriffstoken lebt 15 Minuten
(``jwt_access_ttl_seconds``) und ist ein JWT: niemand kann es zurückrufen. Der
auth-svc prüfte es nur auf Signatur, Ablauf und Kontosperre. Nach „Sitzung
beenden“, „überall sonst abmelden“ oder einem Passwortwechsel holte ein
gestohlenes Token deshalb über ``POST /session/renew`` (Weg 3,
``session_renew.py``) eine frische Cookie-Sitzung — und mit ihr Self-Host-
Tickets, deren Cookie bei Benutzung immer weiter gleitet. Aus 15 Minuten wurde
so ein unbegrenzter Zugang. Gedacht war dagegen ``users.revoke_until``
(Migration 0012): ein Fünf-Minuten-Riegel an ``/credentials/issue``. Der
verschwand mit den Geräte-Zertifikaten (Commit 9be416cce, 2026-08-28); die
Spalte wird seitdem nur noch geschrieben.

**Kette statt Zeitstempel.** Jedes Zugriffstoken trägt seine Anmelde-Kette
(Claim ``kette`` = ``refresh_tokens.family_id``, gestempelt in
``routes._issue_tokens`` und beim Nachreichen in ``/refresh``), und jeder
Widerruf beendet Ketten: Abmelden und „Sitzung beenden“ die eine, „überall
sonst abmelden“ alle außer der eigenen, Passwortwechsel löscht alle Zeilen,
Passwort-Reset und Kontosperre widerrufen alle, der Diebstahlsverdacht in
``/refresh`` die betroffene. Der auth-svc nimmt ein Zugriffstoken deshalb nur
an, solange seine Kette noch eine lebende Zeile hat (``kette_lebt``, gerufen
in ``routes._get_current_user``). Ein Konto-Zeitstempel gegen ``iat`` hätte
zwei Schwächen, die das nicht hat: „überall sonst abmelden“ ließe sich damit
nicht ausdrücken (das Token des Aufrufers ist genauso alt wie das gestohlene),
und ``iat`` zählt ganze Sekunden — das frische Paar, das ein Passwortwechsel
dem eigenen Gerät ausstellt, fiele meist in dieselbe Sekunde wie der Widerruf.

**Wo das nicht greift — bewusst.** chat-gateway, voice-signaling und media-svc
prüfen Zugriffstoken selbst über JWKS, ohne Datenbank, und das bleibt so. Dort
gilt ein widerrufenes Token bis zu seinem Ablauf (≤ 15 min) weiter — samt dem,
was diese Dienste damit ausstellen: voice-signaling LiveKit-Raumtoken und
media-svc Stream-Token, beide mit vier Stunden Laufzeit
(``livekit_token_ttl_seconds``, ``token_ttl_s``). Was hier zu ist: Cookie,
Refresh-Token und damit das Self-Host-Ticket (cookie-gebunden) — die stellt
nur der auth-svc aus.

**Das Rennen.** Ein Erneuern, das gleichzeitig mit einem Widerruf läuft, legt
seine Sitzung in einer Transaktion an, die der Widerruf nicht sieht (READ
COMMITTED: sein UPDATE erfasst nur festgeschriebene Zeilen), und die neue
Sitzung überlebt. Dasselbe gilt für eine Rotation in ``/refresh``: ihre neue
Zeile entgeht dem DELETE des Passwortwechsels. Dagegen hilft
``konto_sperren``: wer Sitzungen oder Refresh-Token eines Kontos anlegt
(``/session/renew``, ``/refresh``) oder widerruft (Passwortwechsel und
-Reset, „Sitzung beenden“, „überall sonst abmelden“, Abmelden mit
Refresh-Token, Kontosperre), sperrt ZUERST die Konto-Zeile. Dann wartet der
eine auf den andern, und wer zweitens kommt, liest den Stand des Ersten —
``session_renew`` prüft dafür die Kette nach der Sperre noch einmal. Zuerst
heißt: vor jedem Schreiben auf Sitzungs- oder Token-Zeilen; wer die vorher
sperrt und das Konto danach, kann sich mit einem Erneuern gegenseitig
festhalten. Nicht gesperrt wird beim Abmelden nur mit Cookie (es beendet
allein das eigene Cookie) und bei der Anmeldung.

Gemessen am 2026-10-17 gegen Postgres 15 (Wegwerf-Cluster, echte Routen über
ASGI): erzwungene Verschränkung in beiden Reihenfolgen vorher 5 von 5 Läufen
mit überlebender Sitzung, danach 0; Dauer-Erneuern gegen Passwortwechsel bzw.
„überall sonst abmelden“ vorher 20 von 20 (Lücke und Rennen zusammen), danach
0 von 20; Dauer-Rotieren
gegen Passwortwechsel vorher 5 bis 7 von 20 mit überlebender Kette, danach 0.
Auf SQLite (Tests) ist ``FOR UPDATE`` wirkungslos; dort gibt es ohnehin nur
einen Schreiber, und ``test_session_renew`` stellt das Warten nach.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_auth.models import RefreshToken, User

#: Wo ``_get_current_user`` die Kette eines Bearer-Tokens für die Route ablegt.
_STATE_ATTR = "pulse_anmeldekette"


async def konto_sperren(db: AsyncSession, user_id: int) -> None:
    """Die Konto-Zeile bis zum Ende der Transaktion sperren (Modulkopf, „Das
    Rennen“). Ein ``rollback`` gibt die Sperre frei."""
    await db.execute(select(User.id).where(User.id == user_id).with_for_update())


async def kette_lebt(db: AsyncSession, *, user_id: int, kette: object) -> bool:
    """Hat die Anmelde-Kette ``kette`` noch einen nicht widerrufenen, nicht
    abgelaufenen Refresh-Token dieses Kontos?

    Ohne Kette (oder mit unlesbarer) ``False``: jedes Zugriffstoken, das der
    auth-svc ausstellt, trägt eine. Die Kette überlebt jede Rotation; bei einer
    Rotation entstehen der Widerruf der alten und die neue Zeile in derselben
    Transaktion, eine lebende Kette ist also nie kurz „leer“.
    """
    if not isinstance(kette, str):
        return False
    try:
        family_id = uuid.UUID(kette)
    except ValueError:
        return False
    stmt = (
        select(RefreshToken.jti)
        .where(
            RefreshToken.family_id == family_id,
            RefreshToken.user_id == user_id,
            RefreshToken.revoked_at.is_(None),
            RefreshToken.expires_at > datetime.now(UTC),
        )
        .limit(1)
    )
    return (await db.execute(stmt)).first() is not None


def merke_bearer_kette(request: Request, kette: str) -> None:
    """Die geprüfte Kette des Bearer-Tokens dieser Anfrage ablegen."""
    setattr(request.state, _STATE_ATTR, kette)


def bearer_kette(request: Request) -> str | None:
    """Die Kette, mit der sich DIESE Anfrage per Bearer angemeldet hat —
    ``None``, wenn sie über das Cookie kam."""
    return getattr(request.state, _STATE_ATTR, None)


__all__ = ["bearer_kette", "kette_lebt", "konto_sperren", "merke_bearer_kette"]
