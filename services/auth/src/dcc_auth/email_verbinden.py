"""Hinweis-Mails beim Verbinden eines Servers mit einem Konto — Texte und Versand.

Aus ``email.py`` ausgelagert (Größen-Policy); versendet wird über
``email.send_email``. Kein Code und keine Kennung im Text — beides öffnete
einen fremden Server, und Mails liegen in Postfächern, die niemand von uns
kontrolliert.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from dcc_auth.email import send_email
from dcc_auth.models import User

log = logging.getLogger(__name__)


async def hinweis_mail(db, empfaenger: User, mail: tuple[str, str]) -> None:
    """Gegenmittel gegen untergeschobene Links (Entwurf E5) — an den, der
    bestätigt hat, und bei einer Übernahme an den bisherigen Besitzer.

    Ein Fehlschlag beim Versand bricht nichts ab — der Server ist zu diesem
    Zeitpunkt schon eingetragen (oder der Antrag gestellt), und ein 500 hiesse
    für den Betreiber „hat nicht geklappt“, obwohl es geklappt hat.
    """
    betreff, text = mail
    try:
        await send_email(empfaenger.email, betreff, text, session=db)
    except Exception as exc:  # noqa: BLE001
        log.warning("verbinden_hinweis_mail_fehlgeschlagen user_id=%s: %s", empfaenger.id, exc)


def compose_verbinden_hinweis(hostname: str, zeitpunkt: datetime) -> tuple[str, str]:
    """Hinweis nach dem Verbinden eines Servers mit dem Konto (Entwurf
    2026-10-09, E5): Wer einen ihm untergeschobenen Link bestätigt hat,
    erfährt es spätestens hier. Kein Code, keine Kennung im Text."""
    subject = "Pulse: Ein Server wurde mit deinem Konto verbunden"
    body = (
        f"Hallo,\n\n"
        f"dein Pulse-Konto wurde soeben mit einem Server verbunden:\n\n"
        f"  Adresse:   {hostname}\n"
        f"  Zeitpunkt: {zeitpunkt.astimezone(UTC):%Y-%m-%d %H:%M} UTC\n\n"
        f"Der Server erscheint jetzt unter Meine Server und in der Leiste\n"
        f"deiner Geräte.\n\n"
        f"Warst du das nicht? Lösche den Server in Pulse unter Meine Server.\n"
    )
    return subject, body


def compose_verbinden_uebernahme(hostname: str, zeitpunkt: datetime) -> tuple[str, str]:
    """Hinweis an den bisherigen Besitzer, wenn ein anderes Konto seine
    Adresse übernommen hat (Entwurf 2026-10-09, E2). Die Cloud weiss nur,
    dass unter der Adresse jetzt ein Server läuft, der den Nachweis liefert —
    nicht, wer davorsitzt. Der Text behauptet deshalb nichts darüber."""
    subject = "Pulse: Dein Server wurde mit einem anderen Konto verbunden"
    body = (
        f"Hallo,\n\n"
        f"dein Server wurde soeben mit einem anderen Pulse-Konto verbunden:\n\n"
        f"  Adresse:   {hostname}\n"
        f"  Zeitpunkt: {zeitpunkt.astimezone(UTC):%Y-%m-%d %H:%M} UTC\n\n"
        f"Dein bisheriger Eintrag ist damit gelöscht und erscheint nicht mehr\n"
        f"unter Meine Server.\n\n"
        f"Wer den Server unter dieser Adresse betreibt, hat ihn neu verbunden.\n"
        f"Warst du das nicht, prüfe, wer Zugriff auf den Rechner und die Domain hat.\n"
    )
    return subject, body


def compose_uebernahme_beantragt(hostname: str, frist_bis: datetime) -> tuple[str, str]:
    """An den bisherigen Besitzer, sobald ein anderes Konto die Übernahme
    seiner Adresse beantragt (Widerspruchsfrist, Entwurf 2026-10-09 E2,
    Nachtrag 2026-10-11). Geht nur beim Anlegen des Antrags raus, unmittelbar
    nach dem Klick — der Zeitpunkt ist deshalb der des Schreibens."""
    subject = "Pulse: Jemand möchte deinen Server übernehmen"
    body = (
        f"Hallo,\n\n"
        f"ein anderes Pulse-Konto hat soeben beantragt, deinen Server mit sich\n"
        f"zu verbinden:\n\n"
        f"  Adresse:   {hostname}\n"
        f"  Zeitpunkt: {datetime.now(UTC):%Y-%m-%d %H:%M} UTC\n"
        f"  Fristende: {frist_bis.astimezone(UTC):%Y-%m-%d %H:%M} UTC\n\n"
        f"Bis zum Fristende geschieht nichts. Danach kann das andere Konto den\n"
        f"Server mit sich verbinden, und dein Eintrag wird gelöscht.\n\n"
        f"Hast du den Server nicht abgegeben? Widersprich unter Meine Server.\n"
        f"Hast du ihn abgegeben, musst du nichts tun — oder lösche ihn unter\n"
        f"Meine Server, dann geht es sofort.\n"
    )
    return subject, body
