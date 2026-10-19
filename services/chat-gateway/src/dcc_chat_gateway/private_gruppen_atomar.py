"""Atomare Bausteine fuer das Lebensende einer privaten Gruppe.

Zwei Wege fuehren dorthin, dass eine Gruppe leer wird oder ihre Ersteller-
Rolle weitergeben muss: ein Mitglied geht selbst (``routes/private_gruppen.py``)
oder ein Konto wird geloescht (``user_purge_gruppen.py``). Beide brauchten
frueher dieselbe Rechnung zweimal, einmal je Aufrufer — und beide Fassungen
lasen die verbleibenden Mitglieder per SELECT und schrieben dann bedingt
zurueck. Zwei Mitglieder, die GLEICHZEITIG als letzte gehen, sahen unter
READ COMMITTED beide noch die je andere Zeile als vorhanden: keine der
beiden Anfragen loeschte die Gruppe, beide Mitgliedszeilen verschwanden
trotzdem, und die Gruppenzeile blieb mit null Mitgliedern stehen —
unauffindbar (``gruppen_auflisten`` filtert nach Mitgliedschaft,
``gruppe_lesen`` 404t fuer Nichtmitglieder) und fuer immer verwaist.

Die beiden Funktionen hier schliessen das, indem die Bedingung (``NOT
EXISTS``/``EXISTS``) im SELBEN Statement wie die Aenderung steckt — kein
Lese-dann-Schreib-Fenster mehr, in das eine zweite gleichzeitige Anfrage
hineinfunken kann (dasselbe Muster wie ``routes/postfach_abholen.py`` bei
der Nutzlast-Aufraeumung). Keine der beiden committet selbst: der Aufrufer
entscheidet, ob ein Schritt fuer sich allein steht (die Route committet
nach jedem) oder Teil einer groesseren, noch offenen Transaktion ist (der
Konto-Purge committet erst ganz am Ende, s. dessen Modul-Docstring)."""

from __future__ import annotations

from sqlalchemy import case, exists, select
from sqlalchemy import delete as sa_delete
from sqlalchemy import update as sa_update

from dcc_chat_gateway.haekchen import kanaele_loeschen
from dcc_chat_gateway.models import PrivateGroupChannel, PrivateGroupMember


async def gruppe_loeschen_wenn_leer(session, gruppe_id: int) -> bool:
    """Loescht die Gruppe genau dann, wenn sie JETZT keine Mitglieder mehr
    hat (Festlegung 2 aus ``routes/private_gruppen.py``). Rueckgabe:
    ``True``, wenn die Gruppe dabei tatsaechlich verschwand."""
    ergebnis = await session.execute(
        sa_delete(PrivateGroupChannel).where(
            PrivateGroupChannel.id == gruppe_id,
            ~exists(
                select(PrivateGroupMember.id).where(
                    PrivateGroupMember.gruppe_id == gruppe_id
                )
            ),
        )
    )
    if not ergebnis.rowcount:
        return False
    # Die Zustellstaende haengen ohne Fremdschluessel an der Gruppe
    # (``haekchen.py``) — die Kaskade, die ``gruppen_lesestand`` mitnimmt,
    # erreicht sie nicht.
    await kanaele_loeschen(session, [gruppe_id])
    # Das Gruppenbild liegt ausserhalb der DB. Spaeter-Import: das Routen-
    # Modul importiert ``routes.private_gruppen``, und das wiederum dieses
    # Modul. Die Datei geht VOR dem Commit des Aufrufers — rollt der zurueck,
    # bleibt eine Gruppe ohne Bilddatei (das Bild fehlt), nie umgekehrt eine
    # Datei ohne Gruppe.
    from dcc_chat_gateway.routes.gruppen_icons import icon_dateien_loeschen  # noqa: PLC0415

    icon_dateien_loeschen(gruppe_id)
    return True


async def ersteller_erbe_uebertragen(session, gruppe_id: int, user_id: int) -> None:
    """Setzt Festlegung 1 um — der dienstaelteste verbleibende Admin erbt
    ``ersteller_id``, ohne Admin das dienstaelteste Mitglied (Rollen-Vertrag
    2026-10-19) — als reines Compare-and-Swap: die ``WHERE
    ersteller_id = :user_id``-Bedingung UND der Erbe-Auswahl-Subquery werden
    beim Ausfuehren FRISCH gegen die DB geprueft, nie gegen einen im
    Python-Speicher gehaltenen Wert. Ein No-Op, wenn ``user_id`` gerade gar
    nicht (mehr) Ersteller ist, oder wenn die Gruppe gerade keine Mitglieder
    (mehr) hat (``EXISTS``-Wache — sonst wuerde der Subquery NULL liefern
    und die NOT-NULL-Spalte ``ersteller_id`` verletzen).

    Weil die Bedingung jedes Mal frisch geprueft wird, heilt sich eine
    kurzzeitig „falsche" Erbin von selbst: durchlaeuft SIE spaeter ihren
    eigenen Austritt, greift dieselbe Wache erneut — entweder findet
    ``gruppe_loeschen_wenn_leer`` dann eine wirklich leere Gruppe, oder
    dieser Aufruf hier reicht die Rolle ein zweites Mal weiter.

    Danach traegt die Zeile des JETZIGEN Besitzers ``rolle='owner'`` — die
    Spalte spiegelt ``ersteller_id`` nur (Migration 0107), massgeblich bleibt
    ``ersteller_id`` (``routes/private_gruppen.py::_rolle``)."""
    erbe = (
        select(PrivateGroupMember.user_id)
        .where(PrivateGroupMember.gruppe_id == gruppe_id)
        .order_by(
            case((PrivateGroupMember.rolle == "admin", 0), else_=1),
            PrivateGroupMember.beigetreten_am,
            PrivateGroupMember.id,
        )
        .limit(1)
        .scalar_subquery()
    )
    await session.execute(
        sa_update(PrivateGroupChannel)
        .where(
            PrivateGroupChannel.id == gruppe_id,
            PrivateGroupChannel.ersteller_id == user_id,
            exists(
                select(PrivateGroupMember.id).where(
                    PrivateGroupMember.gruppe_id == gruppe_id
                )
            ),
        )
        .values(ersteller_id=erbe)
    )
    await owner_zeile_nachziehen(session, gruppe_id)


async def owner_zeile_nachziehen(session, gruppe_id: int) -> None:
    """Setzt ``rolle='owner'`` an der Mitgliedszeile, auf die ``ersteller_id``
    gerade zeigt — in derselben Anweisung gelesen, also nie gegen einen
    veralteten Python-Wert. Ein No-Op, wenn diese Zeile fehlt."""
    besitzer = (
        select(PrivateGroupChannel.ersteller_id)
        .where(PrivateGroupChannel.id == gruppe_id)
        .scalar_subquery()
    )
    await session.execute(
        sa_update(PrivateGroupMember)
        .where(
            PrivateGroupMember.gruppe_id == gruppe_id,
            PrivateGroupMember.user_id == besitzer,
        )
        .values(rolle="owner")
    )
