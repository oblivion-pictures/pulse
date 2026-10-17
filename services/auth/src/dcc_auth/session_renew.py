"""``POST /session/renew``: welches Cookie der Browser danach hält.

Die Route (``routes.renew_session``) prüft nur die Anmeldung; was mit dem
vorgelegten Cookie geschieht, steht hier. Drei Wege, nach dem Zustand der
Zeile, auf die das Cookie zeigt:

1. **Cookie gehört dem Konto und ist nicht widerrufen** (lebend oder nur
   abgelaufen): ablösen. Neue Sitzung anlegen, die alte mit ``replaced_by``
   widerrufen, die Refresh-Token genau umhängen.
2. **Cookie ist widerrufen und hat einen lebenden Nachfolger**: den Nachfolger
   **nachreichen** — keine neue Sitzung. Das ist der Fall, in dem das
   Set-Cookie einer früheren Ablösung nie im Browser ankam (2026-10-17 in der
   iOS-Hülle gemessen: Neuladen drei Sekunden nach dem Erneuern; danach über
   30 Erneuerungen mit 204 ohne Cookie und 100 Ticket-Abrufe mit 401 in acht
   Minuten) — UND der Verlierer zweier gleichzeitiger Erneuerungen.
3. **Sonst** (unbekannt, fremdes Konto, widerrufen ohne lebenden Nachfolger,
   unlesbar): wie ganz ohne Cookie — neue Sitzung aus der Bearer-Anmeldung,
   verwaiste Token umhängen.

**Bughunt Runde 33 (zwei parallele Erneuerungen mit demselben Cookie, etwa
mehrere Tabs beim Start).** Früher hingen beide die Refresh-Kette um und
widerriefen sich gegenseitig; der Browser behielt das Cookie des Verlierers —
eine lebende, in ``/sessions`` unsichtbare Sitzung. Der damalige Riegel („0
umgehängte Token → kein Cookie“) unterschied den Verlierer nicht vom toten
Cookie, und genau dort blieb die iOS-Hülle hängen. Heute entscheidet das
Widerrufen selbst: ``revoke_sessions`` trifft nur Zeilen, die noch nicht
widerrufen sind, also kann genau EIN Aufruf die alte Zeile ablösen (auf
Postgres wartet der zweite UPDATE auf die Zeilensperre des ersten und findet
danach nichts mehr). Der Verlierer rollt seine Sitzung zurück und reicht den
Nachfolger des Gewinners nach — beide Antworten setzen dasselbe Cookie, egal
in welcher Reihenfolge sie ankommen. Kommt der zweite Aufruf erst nach dem
Gewinner an, findet er das Cookie schon widerrufen: Weg 2, dasselbe Ergebnis.

**Warum das Nachreichen nichts wiederbelebt.** Eine widerrufene Zeile wird nie
zurückgeholt, und jeder Weg setzt eine gültige Anmeldung voraus: ein totes
Cookie allein lässt ``_get_current_user`` gar nicht durch (→ 401). Ohne Bearer
kommt hier nur ein Cookie an, das beim Prüfen noch lebte; wird es währenddessen
von einem parallelen Aufruf abgelöst, bekommt es auf Weg 2 genau das Cookie,
das der Gewinner diesem Browser gerade setzt — verliert es gegen einen
Sicherheits-Widerruf, bleibt nichts, woraus eine Sitzung entstehen dürfte
(``None``, die Route antwortet 401; Weg 3 nur mit Bearer). Weg 3 gibt einem
Bearer nicht mehr, als er ganz ohne Cookie bekäme.

Weg 2 reicht eine Sitzung mit womöglich ``acr="1"`` heraus, aber nur über eine
Kette aus ``replaced_by``-Verweisen, die am vorgelegten Cookie beginnt, und nur
an dasselbe Konto. Das Cookie ist ``HttpOnly``: wer seinen Wert vorlegt, ist
dieser Browser, und der hielt den Nachfolger schon (bzw. hätte ihn halten
sollen). Ein Bearer allein — etwa aus einem XSS-Diebstahl, von woanders
vorgelegt — erbt dagegen weiter nie MFA (Weg 3, Regel aus
``geerbter_kontext``). Ein Sicherheits-Widerruf (überall abmelden,
Passwortwechsel, „Sitzung beenden“) trifft den Nachfolger mit, denn er ist
die Sitzung, an der jetzt die Token hängen — danach gibt es nichts
nachzureichen. Ein Kontingent wie beim Nachreichen von Refresh-Token
(``refresh_kette.NACHREICH_LIMIT``) braucht es nicht: dort verlängert jedes
Nachreichen den Zugang, hier setzt jedes eine gültige Anmeldung voraus und
verlängert nichts, was die Anfrage nicht ohnehin hätte.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_auth.browser_sessions import _DEFAULT_TTL, create_session
from dcc_auth.models import UserSession
from dcc_auth.session_link import as_sid, parse_sid, relink_to_new_session, revoke_sessions

#: Antwortkopf, der dem Klienten sagt, welcher Weg genommen wurde. Gelesen von
#: ``web/src/lib/api/cookie-client.ts`` (``renewSession``) — synchron halten.
KOPF = "X-Pulse-Sitzung"
#: Eine neue Sitzung wurde angelegt (Weg 1 oder 3).
NEU = "neu"
#: Ein schon bestehender Nachfolger wurde noch einmal gesetzt (Weg 2). Kommt
#: das mehrmals hintereinander, behält der Browser das Cookie nicht.
NACHGEREICHT = "nachgereicht"

# Mehr Glieder hat eine echte Kette nicht: jedes Glied braucht eine Anfrage,
# die das vorige Cookie vorlegte, und der Browser hat nur ein Cookie-Fach.
_MAX_GLIEDER = 5

_OHNE_NACHWEIS: tuple[list[str], str] = (["pwd"], "0")


@dataclass(frozen=True)
class Erneuert:
    """Das Cookie, das die Route setzt: Sitzungskennung und ``NEU``/``NACHGEREICHT``."""

    sid: str
    art: str


def _aware(ts: datetime) -> datetime:
    return ts if ts.tzinfo else ts.replace(tzinfo=UTC)


async def _frisch(db: AsyncSession, sid: str | None) -> UserSession | None:
    """Zeile neu aus der Datenbank lesen, am Identity-Map vorbei — nach einem
    verlorenen Rennen muss der Stand des Gewinners sichtbar sein."""
    if sid is None:
        return None
    stmt = (
        select(UserSession)
        .where(UserSession.session_id == sid)
        .execution_options(populate_existing=True)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


def geerbter_kontext(row: UserSession) -> tuple[list[str], str]:
    """(amr, acr) für die Sitzung, die ``row`` ablöst (bis 2026-10
    ``routes._strongest_session_context``).

    Das Zugriffstoken trägt kein acr/amr; der einzige Beleg der
    Anmeldestärke ist die Zeile, die DIESE Anfrage selbst beweist — die ihres
    eigenen Cookies. Sie darf abgelaufen sein (dann ist es immer noch die
    eigene Sitzung in diesem Browser, und ein MFA-Nutzer behält seinen
    Step-up), aber nicht widerrufen: ein Widerruf ist ein bewusster Abbau
    (überall abmelden, Passwortwechsel, Sperre). Gerufen wird das nur auf
    Weg 1, wo beides schon geprüft ist. Andere Sitzungen des Kontos werden
    bewusst NICHT durchsucht: eine Zeile eines anderen Geräts beweist diese
    Anfrage nicht, und ein Bearer ohne Cookie bekommt den Passwort-Standard —
    nie ``acr="1"`` am MFA-Tor von ``/credentials/issue`` vorbei.
    """
    return (list(row.amr) if row.amr else ["pwd"]), (row.acr or "0")


async def _lebender_nachfolger(
    db: AsyncSession, row: UserSession, user_id: int, now: datetime
) -> UserSession | None:
    """Der lebende Nachfolger über die ``replaced_by``-Kette, sonst ``None``."""
    glied = row
    for _ in range(_MAX_GLIEDER):
        naechstes = await _frisch(db, as_sid(glied.replaced_by))
        if naechstes is None or naechstes.user_id != user_id:
            return None
        if naechstes.revoked_at is None:
            return naechstes if _aware(naechstes.expires_at) > now else None
        glied = naechstes
    return None


async def erneuere_cookie(
    db: AsyncSession,
    *,
    user_id: int,
    cookie: str | None,
    mit_bearer: bool,
    user_agent: str | None,
    ip: str | None,
) -> Erneuert | None:
    """Den Weg wählen (Modulkopf) und gehen. Committet selbst.

    ``user_id`` kommt aus der geprüften Anmeldung, nicht aus dem Cookie — und
    muss vorab gelesen sein: nach dem Rollback eines verlorenen Rennens ist das
    ``User``-Objekt der Route abgelaufen. ``mit_bearer``: die Anmeldung kam
    über ein gültiges Zugriffstoken (nur dann ist Weg 3 erlaubt).
    """
    now = datetime.now(UTC)
    alt_sid = parse_sid(cookie)
    alt = await _frisch(db, alt_sid)
    if alt is not None and alt.user_id != user_id:
        # Eine Kennung ist keine Berechtigung: fremde Zeilen bleiben unberührt.
        alt = None

    if alt is not None and alt.revoked_at is None:
        amr, acr = geerbter_kontext(alt)
        sid = str(
            await create_session(
                db, user_id=user_id, amr=amr, acr=acr, user_agent=user_agent, ip=ip
            )
        )
        if await revoke_sessions(db, [alt_sid], user_id=user_id, now=now, replaced_by=sid):
            await relink_to_new_session(
                db, user_id=user_id, old_sid=alt_sid, new_sid=sid, user_agent=user_agent
            )
            await db.commit()
            return Erneuert(sid, NEU)
        # Ein paralleler Aufruf hat dieselbe Zeile eben abgelöst.
        await db.rollback()
        alt = await _frisch(db, alt_sid)

    if alt is not None:
        nachfolger = await _lebender_nachfolger(db, alt, user_id, now)
        if nachfolger is not None:
            # Das Cookie bekommt gleich wieder volle 30 Minuten — die Zeile auch,
            # sonst liefe sie vor dem Cookie ab.
            nachfolger.last_seen_at = now
            nachfolger.expires_at = now + timedelta(seconds=_DEFAULT_TTL)
            await db.commit()
            return Erneuert(as_sid(nachfolger.session_id) or "", NACHGEREICHT)

    if not mit_bearer:
        return None
    amr, acr = _OHNE_NACHWEIS
    sid = str(
        await create_session(db, user_id=user_id, amr=amr, acr=acr, user_agent=user_agent, ip=ip)
    )
    await relink_to_new_session(
        db, user_id=user_id, old_sid=None, new_sid=sid, user_agent=user_agent
    )
    await db.commit()
    return Erneuert(sid, NEU)


__all__ = ["KOPF", "NACHGEREICHT", "NEU", "Erneuert", "erneuere_cookie", "geerbter_kontext"]
