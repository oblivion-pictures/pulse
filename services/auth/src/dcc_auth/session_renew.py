"""``POST /session/renew``: welches Cookie der Browser danach hält.

Die Route (``routes.renew_session``) prüft nur die Anmeldung; was mit dem
vorgelegten Cookie geschieht, steht hier. Drei Wege, nach dem Zustand der
Zeile, auf die das Cookie zeigt:

1. **Cookie gehört dem Konto und ist nicht widerrufen** (lebend oder nur
   abgelaufen): ablösen. Neue Sitzung anlegen, die alte mit ``replaced_by``
   widerrufen, die Refresh-Token genau umhängen.
2. **Cookie wurde durch genau eine noch lebende, höchstens zehn Minuten alte
   Sitzung abgelöst**: diesen Nachfolger **nachreichen** — keine neue Sitzung,
   nichts verlängert. Das ist der Fall, in dem das Set-Cookie einer früheren
   Ablösung nie im Browser ankam (2026-10-17 in der iOS-Hülle gemessen: Neuladen
   drei Sekunden nach dem Erneuern; danach über 30 Erneuerungen mit 204 ohne
   Cookie und 100 Ticket-Abrufe mit 401 in acht Minuten) — UND der Verlierer
   zweier gleichzeitiger Erneuerungen.
3. **Sonst** (unbekannt, fremdes Konto, widerrufen ohne passenden Nachfolger,
   unlesbar): wie ganz ohne Cookie — neue Sitzung aus der Bearer-Anmeldung,
   verwaiste Token umhängen. Nur mit Bearer, und nur, solange dessen
   Anmelde-Kette lebt: ein Zugriffstoken, das vor „Sitzung beenden“, „überall
   sonst abmelden“ oder einem Passwortwechsel ausgestellt wurde, kommt schon an
   ``_get_current_user`` nicht vorbei (``widerruf.py``). Bis 2026-10-17 holte
   es hier eine frische Sitzung.

**Bughunt Runde 33 (zwei parallele Erneuerungen mit demselben Cookie, etwa
mehrere Tabs beim Start).** Früher hingen beide die Refresh-Kette um und
widerriefen sich gegenseitig; der Browser behielt das Cookie des Verlierers —
eine lebende, in ``/sessions`` unsichtbare Sitzung. Der damalige Riegel („0
umgehängte Token → kein Cookie“) unterschied den Verlierer nicht vom toten
Cookie, und genau dort blieb die iOS-Hülle hängen. Heute entscheidet das
Widerrufen selbst: ``revoke_sessions`` trifft nur Zeilen, die noch nicht
widerrufen sind, also kann genau EIN Aufruf die alte Zeile ablösen. Seit der
Kontosperre (unten) warten zwei Erneuerungen desselben Kontos auf Postgres
schon am Anfang aufeinander; der zweite findet das Cookie widerrufen: Weg 2,
dasselbe Cookie wie der Gewinner. Der Zweig, in dem der Verlierer seine
Sitzung zurückrollt und den Nachfolger des Gewinners nachreicht, bleibt für
Widerrufe ohne Kontosperre (Abmelden nur mit Cookie) und für SQLite, wo
``FOR UPDATE`` nichts sperrt — auch dort setzen beide Antworten dasselbe
Cookie.

**Gegen einen gleichzeitigen Widerruf.** Jeder Aufruf sperrt zuerst die
Konto-Zeile (``widerruf.konto_sperren``) und prüft danach die Bearer-Kette
noch einmal; ein Rollback gibt die Sperre frei, danach also dasselbe noch
einmal. Die Widerrufswege sperren dieselbe Zeile, bevor sie schreiben. Ohne
das sah ein gleichzeitiges „überall abmelden“ die noch nicht festgeschriebene
neue Sitzung nicht, und sie überlebte (Begründung: ``widerruf.py``).

**Was Weg 2 herausgibt, und warum es so eng ist.** Eine widerrufene Zeile wird
nie zurückgeholt, und jeder Weg setzt eine gültige Anmeldung voraus: ein totes
Cookie allein lässt ``_get_current_user`` nicht durch (→ 401). Ohne Bearer
kommt hier nur ein Cookie an, das beim Prüfen noch lebte; wird es währenddessen
von einem parallelen Aufruf abgelöst, bekommt es auf Weg 2 das Cookie des
Gewinners — verliert es gegen einen Widerruf ohne Nachfolger, gibt es ``None``
(Route: 401), denn Weg 3 läuft nur mit Bearer. Weg 3 gibt einem Bearer nicht
mehr, als er ganz ohne Cookie bekäme, und erbt nie ``acr="1"``.

Weg 2 dagegen reicht eine bestehende Sitzung samt ihrem ``acr`` heraus — und
das ``acr`` reist ins Self-Host-Ticket (``routes_server_ticket.py``). Ein
abgelöstes Cookie ist nicht wertlos geworden, nur weil es widerrufen ist: wer
einen alten Wert und einen Bearer desselben Kontos hat, bekäme sonst die
aktuelle Sitzung des Browsers. Deshalb drei Grenzen, alle in
``_nachreichbarer_nachfolger``:

* **Genau ein Glied.** Nur ``alt.replaced_by`` selbst, die Kette wird nicht
  weiterverfolgt. Das deckt beide Fälle, für die es Weg 2 gibt (verlorenes
  Set-Cookie, verlorenes Rennen); ein Cookie, das schon zwei Ablösungen hinter
  sich hat, gehört zu keinem davon.
* **Zehn Minuten** ab ``created_at`` des Nachfolgers (``NACHREICH_FENSTER``).
  Im iOS-Fall kam das alte Cookie Sekunden nach der Ablösung wieder, im Rennen
  sind es Millisekunden. Danach fällt der Aufruf auf Weg 3: frische Sitzung
  mit ``acr="0"`` — der Nutzer verliert höchstens den Step-up, nicht die
  Anmeldung.
* **Nachfolger lebt**: nicht widerrufen, nicht abgelaufen, dasselbe Konto. Ein
  Widerruf nach der Ablösung — überall abmelden, Passwortwechsel, „Sitzung
  beenden“ (das trifft das Cookie, an dem die Token jetzt hängen, also den
  Nachfolger) — beendet damit auch das Nachreichen.

Nachreichen verlängert nichts: die Zeile behält ihr ``expires_at``. Läuft sie
vor dem 30-Minuten-Cookie ab, kommt der nächste Aufruf mit 401 zurück, und das
folgende Erneuern löst sie auf Weg 1 regulär ab. Ein Kontingent wie beim
Nachreichen von Refresh-Token (``refresh_kette.NACHREICH_LIMIT``) braucht es
deshalb nicht — dort verlängert jedes Nachreichen den Zugang.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_auth.browser_sessions import create_session
from dcc_auth.models import UserSession
from dcc_auth.session_link import as_sid, parse_sid, relink_to_new_session, revoke_sessions
from dcc_auth.widerruf import kette_lebt, konto_sperren

#: Antwortkopf, der dem Klienten sagt, welcher Weg genommen wurde. Gelesen von
#: ``web/src/lib/api/cookie-client.ts`` (``renewSession``) — synchron halten.
KOPF = "X-Pulse-Sitzung"
#: Eine neue Sitzung wurde angelegt (Weg 1 oder 3).
NEU = "neu"
#: Ein schon bestehender Nachfolger wurde noch einmal gesetzt (Weg 2). Kommt
#: das mehrmals hintereinander, behält der Browser das Cookie nicht.
NACHGEREICHT = "nachgereicht"

#: Wie lange nach einer Ablösung das abgelöste Cookie den Nachfolger noch
#: bekommt (Modulkopf: „Was Weg 2 herausgibt“).
NACHREICH_FENSTER = timedelta(minutes=10)

_OHNE_NACHWEIS: tuple[list[str], str] = (["pwd"], "0")


@dataclass(frozen=True)
class Erneuert:
    """Das Cookie, das die Route setzt: Sitzungskennung und ``NEU``/``NACHGEREICHT``."""

    sid: str
    art: str


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
    Step-up), aber nicht widerrufen (abgelöst, abgemeldet, Passwortwechsel,
    Sperre). Gerufen wird das nur auf Weg 1, wo beides schon geprüft ist.
    Andere Sitzungen des Kontos werden bewusst NICHT durchsucht: eine Zeile
    eines anderen Geräts beweist diese Anfrage nicht, und ein Bearer ohne
    Cookie bekommt den Passwort-Standard — nie ``acr="1"``, das sonst ins
    Self-Host-Ticket reiste (``routes_server_ticket.py``).
    """
    return (list(row.amr) if row.amr else ["pwd"]), (row.acr or "0")


async def _nachreichbarer_nachfolger(
    db: AsyncSession, alt: UserSession, user_id: int, now: datetime
) -> UserSession | None:
    """``alt.replaced_by``, wenn er nachgereicht werden darf, sonst ``None``.

    Die drei Grenzen und ihre Begründung: Modulkopf, „Was Weg 2 herausgibt“.
    Die Prüfung auf ``revoked_at IS NULL`` steht in der Abfrage selbst.
    """
    sid = as_sid(alt.replaced_by)
    if sid is None:
        return None
    stmt = (
        select(UserSession)
        .where(
            UserSession.session_id == sid,
            UserSession.user_id == user_id,
            UserSession.revoked_at.is_(None),
            UserSession.expires_at > now,
            UserSession.created_at >= now - NACHREICH_FENSTER,
        )
        .execution_options(populate_existing=True)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def _gesperrt_und_gueltig(
    db: AsyncSession, user_id: int, bearer_kette: str | None
) -> bool:
    """Konto sperren, dann die Bearer-Anmeldung nachprüfen (Modulkopf, „Gegen
    einen gleichzeitigen Widerruf“). Ohne Bearer gibt es nichts nachzuprüfen:
    das Cookie wird danach ohnehin frisch gelesen."""
    await konto_sperren(db, user_id)
    return bearer_kette is None or await kette_lebt(db, user_id=user_id, kette=bearer_kette)


async def erneuere_cookie(
    db: AsyncSession,
    *,
    user_id: int,
    cookie: str | None,
    bearer_kette: str | None,
    user_agent: str | None,
    ip: str | None,
) -> Erneuert | None:
    """Den Weg wählen (Modulkopf) und gehen. Committet selbst.

    ``user_id`` kommt aus der geprüften Anmeldung, nicht aus dem Cookie — und
    muss vorab gelesen sein: nach dem Rollback eines verlorenen Rennens ist das
    ``User``-Objekt der Route abgelaufen. ``bearer_kette``: die Anmeldung kam
    über ein gültiges Zugriffstoken dieser Anmelde-Kette (nur dann ist Weg 3
    erlaubt), ``None`` = über das Cookie.
    """
    if not await _gesperrt_und_gueltig(db, user_id, bearer_kette):
        return None
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
        # Ein paralleler Aufruf hat dieselbe Zeile eben abgelöst. Der Rollback
        # gibt die Kontosperre frei — deshalb neu sperren und nachprüfen.
        await db.rollback()
        if not await _gesperrt_und_gueltig(db, user_id, bearer_kette):
            return None
        alt = await _frisch(db, alt_sid)

    if alt is not None:
        nachfolger = await _nachreichbarer_nachfolger(db, alt, user_id, now)
        if nachfolger is not None:
            # Nur lesen, nichts schreiben — Nachreichen verlängert nichts.
            return Erneuert(as_sid(nachfolger.session_id) or "", NACHGEREICHT)

    if bearer_kette is None:
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
