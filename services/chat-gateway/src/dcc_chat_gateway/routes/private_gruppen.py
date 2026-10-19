"""Private Gruppenkanaele (Etappe G1, die Kanal-Haelfte).

``POST /gruppen`` legt eine neue Gruppe an, ``GET /gruppen``/``GET
/gruppen/{id}`` listen sie, ``POST .../mitglieder`` und ``DELETE
.../mitglieder/{user_id}`` verwalten die Mitgliedschaft, ``POST
.../verlassen`` laesst ein Mitglied selbst gehen. Ohne Krypto, ohne
Oberflaeche — s. Umsetzungsplan
``docs/superpowers/plans/2026-08-28-etappe-g1-private-gruppen-kanal.md``.
Umbenennen, Aufloesen, Stumm, Anheften, Rollen und Besitz-Uebergabe stehen in
``routes/private_gruppen_verwaltung.py``, der Lesestand in
``routes/private_gruppen_lesestand.py`` (Groessen-Policy).

**Cloud-only, aus demselben Grund wie Freunde/DM/Blocks**
(``routes/_deps.py::require_cloud``): eine private Gruppe prueft beim
Hinzufuegen dieselbe globale Block-Liste wie eine DM (``block_exists_
either_way``) — sie gehoert zur selben globalen Identitaets-Schicht, nicht
zu einer einzelnen Community. Ein Self-Host hat weder Freunde noch Blocks;
ohne dieses Gate waere eine Gruppe dort die einzige Stelle, an der ein
Hinzufuegen NICHT gegen eine Blockierung geprueft werden kann.

**Drei Festlegungen, die die Spec ausdruecklich verlangt** (§9 + Plan):

1. **Geht der Ersteller, bleibt die Gruppe** — der dienstaelteste
   verbleibende Admin erbt die Rolle, ohne Admin das dienstaelteste
   Mitglied (kleinstes ``beigetreten_am``).
   Begruendung: eine Gruppe, die mit ihrem Gruender verschwindet, nimmt
   allen anderen ihren Verlauf mit — und der liegt ab Etappe C nur noch
   auf Geraeten, es gibt kein Server-Backup, das ihn ersetzen koennte.
   Siehe ``_entferne_mitglied`` unten und
   ``test_ersteller_geht_dienstaeltestes_mitglied_erbt``.
2. **Geht das letzte Mitglied, wird die Gruppe geloescht** — eine Gruppe
   mit null Mitgliedern ist nichts, keine Zeile, die auf niemanden mehr
   zeigt. Siehe ``test_letztes_mitglied_loescht_die_gruppe``.
3. **Blockierte Personen koennen nicht hinzugefuegt werden** — sonst waere
   eine private Gruppe ein Weg, eine Blockierung zu umgehen. Geprueft
   zwischen der hinzufuegenden Person (immer der Ersteller, s. u.) und dem
   Ziel, derselbe Helfer wie ueberall (``block_exists_either_way``).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

import dcc_chat_gateway.config as chat_config
from dcc_chat_gateway.db import SessionDep
from dcc_chat_gateway.friend_helpers import block_exists_either_way
from dcc_chat_gateway.haekchen import MitgliedStaende, gruppen_staende
from dcc_chat_gateway.haekchen import mitglied_loeschen as haekchen_mitglied_loeschen
from dcc_chat_gateway.models import PrivateGroupChannel, PrivateGroupMember
from dcc_chat_gateway.private_gruppen_atomar import (
    ersteller_erbe_uebertragen,
    gruppe_loeschen_wenn_leer,
)
from dcc_chat_gateway.routes._deps import CloudOnly
from dcc_chat_gateway.routes._dropbox_helpers import validate_name
from dcc_chat_gateway.schemas import (
    PrivateGroupCreateIn,
    PrivateGroupMemberAddIn,
    PrivateGroupMemberOut,
    PrivateGroupOut,
)
from dcc_chat_gateway.security import CurrentUser
from dcc_chat_gateway.snowflake import next_id

log = logging.getLogger(__name__)


async def require_private_groups_enabled() -> None:
    """FastAPI-Dependency — 403, solange der Schalter aus ist.

    Vorher stand diese Pruefung NUR in ``POST /gruppen`` — die anderen fuenf
    Routen (Liste/Einzelabruf/Hinzufuegen/Entfernen/Verlassen) liefen auch
    bei ausgeschaltetem Schalter ungehindert weiter. Der Schalter garantierte
    damit nur „keine NEUE Gruppe entsteht", nicht „keine Gruppe ist
    erreichbar" — die Spec verlangt aber Letzteres (s. Modul-Docstring).
    Als Router-Dependency neben ``CloudOnly`` kann eine kuenftige Route das
    nicht mehr vergessen: sie muesste die Dependency aktiv abbestellen.

    Later-Import wie bei ``require_cloud`` (``routes/_deps.py``): Test-
    Fixtures ersetzen ``dcc_chat_gateway.config.get_settings`` erst zur
    Aufrufzeit, nicht zur Importzeit."""
    import dcc_chat_gateway.config as _cfg  # noqa: PLC0415

    if not _cfg.get_settings().private_groups_enabled:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="private_groups_disabled")


router = APIRouter(
    tags=["private-gruppen"],
    dependencies=[CloudOnly, Depends(require_private_groups_enabled)],
)


# ─── Laden + Wire-Form ──────────────────────────────────────────────────────


async def _mitglieder_laden(session, gruppe_id: int) -> list[PrivateGroupMember]:
    stmt = select(PrivateGroupMember).where(PrivateGroupMember.gruppe_id == gruppe_id)
    return list((await session.execute(stmt)).scalars())


def _rolle(gruppe: PrivateGroupChannel, mitglied: PrivateGroupMember) -> str:
    """Die effektive Rolle einer Mitgliedszeile (Rollen-Vertrag 2026-10-19):
    „owner" ist allein, wer in ``ersteller_id`` steht — die übertragbare
    Besitzerrolle ist die Quelle, die Zeilen-Spalte spiegelt sie nur
    (``private_gruppen_atomar.owner_zeile_nachziehen``). Eine Zeile, die
    noch „owner" trägt, ohne Besitzer zu sein, zählt deshalb als
    „mitglied“ — nie als zweiter Owner. Sonst „admin“ (einladen +
    rauswerfen) oder „mitglied“.
    """
    if mitglied.user_id == gruppe.ersteller_id:
        return "owner"
    return "admin" if mitglied.rolle == "admin" else "mitglied"


def _darf_verwalten(gruppe: PrivateGroupChannel, eigene_zeile: PrivateGroupMember) -> bool:
    """Einladen + Rauswerfen: Owner und Admins (Nutzerwunsch 2026-10-19)."""
    return _rolle(gruppe, eigene_zeile) in ("owner", "admin")


def _wire(
    gruppe: PrivateGroupChannel,
    mitglieder: list[PrivateGroupMember],
    betrachter_id: int,
    staende: dict[int, MitgliedStaende] | None = None,
) -> PrivateGroupOut:
    """``staende`` (Häkchen-Treppe, ``haekchen.gruppen_staende``) nur in den
    Lese-Antworten — die Mutations-Antworten lassen sie weg, der Klient
    merged vorwärts und verliert dabei nichts.

    ``stumm`` nur in der Zeile des ``betrachter_id`` — wer welche Gruppe
    stummgeschaltet hat, geht die anderen Mitglieder nichts an; fremde
    Zeilen tragen ``null``."""
    staende = staende or {}
    return PrivateGroupOut(
        id=gruppe.id,
        ersteller_id=gruppe.ersteller_id,
        name=gruppe.name,
        created_at=gruppe.created_at,
        last_message_id=gruppe.last_message_id,
        icon_url=gruppe.icon_url,
        angeheftet_id=gruppe.angeheftet_id,
        members=[
            PrivateGroupMemberOut(
                user_id=m.user_id,
                beigetreten_am=m.beigetreten_am,
                rolle=_rolle(gruppe, m),
                stumm=m.stumm if m.user_id == betrachter_id else None,
                gelesen_bis=st.gelesen_bis if (st := staende.get(m.user_id)) else None,
                zugestellt_bis=st.zugestellt_bis if st else None,
            )
            for m in mitglieder
        ],
    )


async def _gruppe_fuer_mitglied_laden(
    session, gruppe_id: int, user_id: int
) -> tuple[PrivateGroupChannel, PrivateGroupMember]:
    """Laedt die Gruppe NUR, wenn ``user_id`` Mitglied ist — sonst 404, nie
    403: die blosse Existenz einer fremden privaten Gruppe darf ein
    Nichtmitglied nicht erfahren (weder ueber die Liste noch einzeln, s.
    Modul-Docstring Punkt „Nichtmitglied sieht die Gruppe nicht")."""
    eigene = (
        await session.execute(
            select(PrivateGroupMember).where(
                PrivateGroupMember.gruppe_id == gruppe_id,
                PrivateGroupMember.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    if eigene is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="group_not_found")
    gruppe = await session.get(PrivateGroupChannel, gruppe_id)
    if gruppe is None:
        # Kann nur bei einer kaputten Zeile passieren (Mitgliedszeile ohne
        # Gruppe) — CASCADE verhindert das, aber fail-closed statt 500.
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="group_not_found")
    return gruppe, eigene


async def _ziel_zeile(session, gruppe_id: int, user_id: int) -> PrivateGroupMember:
    """Die Mitgliedszeile von ``user_id`` — 404 ``not_a_member``, wenn er
    nicht (mehr) Mitglied ist."""
    ziel = (
        await session.execute(
            select(PrivateGroupMember).where(
                PrivateGroupMember.gruppe_id == gruppe_id,
                PrivateGroupMember.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    if ziel is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not_a_member")
    return ziel


async def _entferne_mitglied(session, gruppe: PrivateGroupChannel, user_id: int) -> bool:
    """Entfernt ``user_id`` aus ``gruppe`` und setzt die Festlegungen 1+2 aus
    dem Modul-Docstring um. Rueckgabe: ``True``, wenn die Gruppe dabei
    komplett geloescht wurde (letztes Mitglied).

    Die eigentliche Atomaritaet steckt in ``private_gruppen_atomar.py``
    (Begruendung + Bug dort); hier nur die Reihenfolge: erst die eigene
    Mitgliedszeile weg und COMMITTET, dann — jeweils mit eigenem Commit —
    entweder die Gruppe loeschen oder die Ersteller-Rolle weiterreichen.
    Jeder Commit ist die Stelle, an der eine gleichzeitige zweite Anfrage
    (derselbe Zweig, ein anderer Nutzer) dazwischenfunken UND sich wieder
    einordnen kann — dasselbe Muster wie ``_einmalschluessel_holen``
    (``routes/schluessel.py``): erst nach dem Commit sehen die naechsten
    Schritte den wirklich aktuellen Stand."""
    await session.execute(
        sa_delete(PrivateGroupMember).where(
            PrivateGroupMember.gruppe_id == gruppe.id,
            PrivateGroupMember.user_id == user_id,
        )
    )
    await haekchen_mitglied_loeschen(session, gruppe.id, user_id)
    await session.commit()

    if await gruppe_loeschen_wenn_leer(session, gruppe.id):
        await session.commit()
        return True

    await ersteller_erbe_uebertragen(session, gruppe.id, user_id)
    await session.commit()
    # ``gruppe`` kann durch den Erbe-Uebergang veraltet sein (expire_on_commit
    # steht in dieser App aus, s. db.py) — der Aufrufer braucht die frische
    # ``ersteller_id`` fuer die Wire-Antwort. ``session.get(...,
    # populate_existing=True)`` statt ``session.refresh``: zwischen unserem
    # eigenen „nicht leer"-Befund und diesem Commit kann eine gleichzeitige
    # dritte Anfrage (der wirklich letzte Austritt) die Gruppe inzwischen
    # doch geloescht haben — ``refresh`` wirft dann
    # ``InvalidRequestError``, ``get`` liefert schlicht ``None``. Dank der
    # Identity Map ist ``gruppe`` bei einem Treffer dasselbe Objekt, der
    # Aufrufer sieht die frischen Werte automatisch.
    aktuelle = await session.get(PrivateGroupChannel, gruppe.id, populate_existing=True)
    return aktuelle is None


# ─── Routen ─────────────────────────────────────────────────────────────────


async def _gruppe_neu_publizieren(request: Request, konten: list[int], gruppe_id: int) -> None:
    """`gruppe_neu` an die Mitglieder — der Weckruf, damit ihre Klienten
    GET /gruppen nachziehen und abonnieren (Befund 05.10.: ohne Ereignis
    erfuhren andere Mitglieder von einer neuen Gruppe erst beim nächsten
    ready — keine Benachrichtigung, keine Live-Nachricht). Best-effort."""
    manager = getattr(request.app.state, "connection_manager", None)
    if manager is None:
        return
    from dcc_shared.events import GruppeNeuEvent

    for konto in set(konten):
        try:
            await manager.publish_user_event(konto, GruppeNeuEvent(gruppe_id=str(gruppe_id)))
        except Exception:
            log.exception("gruppe_neu publish failed for user %s", konto)


async def _alle_wecken(request: Request, session, gruppe_id: int) -> list[PrivateGroupMember]:
    """Mitglieder frisch laden und alle per ``gruppe_neu`` wecken — die Liste
    geht an den Aufrufer zurueck, fuer die Wire-Antwort."""
    mitglieder = await _mitglieder_laden(session, gruppe_id)
    await _gruppe_neu_publizieren(request, [m.user_id for m in mitglieder], gruppe_id)
    return mitglieder


@router.post("/gruppen", status_code=status.HTTP_201_CREATED)
async def gruppe_erstellen(
    body: PrivateGroupCreateIn, session: SessionDep, user: CurrentUser, request: Request
) -> PrivateGroupOut:
    # Der Schalter selbst sitzt seit ``require_private_groups_enabled`` als
    # Router-Dependency (oben) — sie deckt jetzt alle sechs Routen ab, nicht
    # nur diese hier.
    # Display-string sink: der Gruppenname wird der UI genauso vorgesetzt
    # wie ein Kanalname (``routes/channels.py``), also derselbe Filter gegen
    # Pfad-Traversal/Bidi-Override/Homoglyphen.
    try:
        clean_name = validate_name(body.name, max_len=64)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc

    # Obergrenze SELBST ERSTELLTER Gruppen (Bughunt 2026-08-28 (Missbrauch),
    # FIX 5) — ``private_group_max_members`` bindet nur die Groesse einer
    # einzelnen Gruppe, nicht ihre Anzahl; ohne diese Grenze legt ein Konto
    # beliebig viele leere Kanal- plus Mitgliedszeilen an.
    #
    # Gezaehlt wird gegen ``erstellt_von_id``, NICHT ``ersteller_id`` (die
    # uebertragbare Besitzerrolle — Begruendung + Missbrauchsfall in deren
    # Modell-Docstring, ``models/private_gruppen.py``, Migration 0072).
    settings = chat_config.get_settings()
    eigene_gruppen = (
        await session.execute(
            select(func.count())
            .select_from(PrivateGroupChannel)
            .where(PrivateGroupChannel.erstellt_von_id == user.id)
        )
    ).scalar_one()
    if eigene_gruppen >= settings.private_group_max_gruppen_je_ersteller:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="gruppen_limit_erreicht")

    gruppe = PrivateGroupChannel(
        id=next_id(), ersteller_id=user.id, erstellt_von_id=user.id, name=clean_name
    )
    session.add(gruppe)
    session.add(
        PrivateGroupMember(id=next_id(), gruppe_id=gruppe.id, user_id=user.id, rolle="owner")
    )
    await session.commit()
    await _gruppe_neu_publizieren(request, [user.id], gruppe.id)
    mitglieder = await _mitglieder_laden(session, gruppe.id)
    return _wire(gruppe, mitglieder, user.id)


@router.get("/gruppen")
async def gruppen_auflisten(
    session: SessionDep, user: CurrentUser
) -> list[PrivateGroupOut]:
    stmt = select(PrivateGroupMember.gruppe_id).where(PrivateGroupMember.user_id == user.id)
    gruppe_ids = list((await session.execute(stmt)).scalars())
    if not gruppe_ids:
        return []
    gruppen = (
        await session.execute(
            select(PrivateGroupChannel).where(PrivateGroupChannel.id.in_(gruppe_ids))
        )
    ).scalars().all()
    staende = await gruppen_staende(session, user.id, list(gruppe_ids))
    out: list[PrivateGroupOut] = []
    for gruppe in gruppen:
        mitglieder = await _mitglieder_laden(session, gruppe.id)
        out.append(_wire(gruppe, mitglieder, user.id, staende.get(gruppe.id)))
    return out


@router.get("/gruppen/{gruppe_id}")
async def gruppe_lesen(
    gruppe_id: int, session: SessionDep, user: CurrentUser
) -> PrivateGroupOut:
    gruppe, _ = await _gruppe_fuer_mitglied_laden(session, gruppe_id, user.id)
    mitglieder = await _mitglieder_laden(session, gruppe.id)
    staende = await gruppen_staende(session, user.id, [gruppe.id])
    return _wire(gruppe, mitglieder, user.id, staende.get(gruppe.id))


@router.post("/gruppen/{gruppe_id}/mitglieder", status_code=status.HTTP_201_CREATED)
async def mitglied_hinzufuegen(
    gruppe_id: int,
    body: PrivateGroupMemberAddIn,
    session: SessionDep,
    user: CurrentUser,
    request: Request,
) -> PrivateGroupOut:
    gruppe, eigene_zeile = await _gruppe_fuer_mitglied_laden(session, gruppe_id, user.id)
    if not _darf_verwalten(gruppe, eigene_zeile):
        # Rollen-Vertrag 2026-10-19: Owner und Admins laden ein — einfache
        # Mitglieder nicht (Nutzerwunsch: Admin-Rolle „nur einladen und
        # rauswerfen", Mitglieder gar nicht).
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not_allowed")
    ziel_id = int(body.user_id)

    bereits = (
        await session.execute(
            select(PrivateGroupMember).where(
                PrivateGroupMember.gruppe_id == gruppe_id,
                PrivateGroupMember.user_id == ziel_id,
            )
        )
    ).scalar_one_or_none()
    if bereits is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="already_a_member")

    # Festlegung 3: eine Blockierung in beide Richtungen sperrt das
    # Hinzufuegen — sonst waere die Gruppe ein Weg, sie zu umgehen.
    if await block_exists_either_way(session, user.id, ziel_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="blocked")

    settings = chat_config.get_settings()
    anzahl = (
        await session.execute(
            select(func.count())
            .select_from(PrivateGroupMember)
            .where(PrivateGroupMember.gruppe_id == gruppe_id)
        )
    ).scalar_one()
    if anzahl >= settings.private_group_max_members:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="member_limit_reached")

    session.add(PrivateGroupMember(id=next_id(), gruppe_id=gruppe_id, user_id=ziel_id))
    try:
        await session.commit()
    except IntegrityError:
        # Zwei gleichzeitige Hinzufuegungen derselben Person schlagen beide
        # am ``bereits``-SELECT oben durch (Lese-dann-Schreib-Fenster) und
        # verletzen dann ``uq_private_group_members_mitglied`` — ohne diesen
        # Fang ein unbehandelter 500er. Dieselbe Zeile wie in einem guten
        # Dutzend anderer Routen dieses Dienstes (``dms.py``, ``blocks.py``,
        # ``devices.py`` …). Die Mitglieder-Obergrenze direkt darueber hat
        # dieselbe Check-then-Insert-Form und dieselbe Luecke (kann um eins
        # ueberschritten werden), aber KEINE Datenbank-Bedingung, die eine
        # ``IntegrityError`` daraus machen wuerde — dieser Fang deckt sie
        # nicht mit ab. Eine atomare Obergrenze braeuchte ein INSERT mit
        # eingebauter Zaehl-Bedingung (``INSERT … SELECT … WHERE COUNT(*) <
        # cap``), eine groessere Umstellung fuer einen Ein-Personen-Ausreisser
        # an der Grenze — bewusst nicht Teil dieses Fixes.
        await session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, detail="already_a_member") from None
    mitglieder = await _alle_wecken(request, session, gruppe_id)
    return _wire(gruppe, mitglieder, user.id)


@router.delete("/gruppen/{gruppe_id}/mitglieder/{user_id}")
async def mitglied_entfernen(
    gruppe_id: int, user_id: int, session: SessionDep, user: CurrentUser
) -> PrivateGroupOut | None:
    gruppe, eigene_zeile = await _gruppe_fuer_mitglied_laden(session, gruppe_id, user.id)
    ziel_mitglied = await _ziel_zeile(session, gruppe_id, user_id)
    # Rollen-Vertrag 2026-10-19: Owner wirft jeden ANDEREN raus (sich selbst
    # nur per Verlassen), Admins nur einfache Mitglieder — nie Owner oder
    # andere Admins. Einfache Mitglieder gar nicht (Verlassen bleibt ihr Weg).
    if user_id == user.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="selbst_verlassen")
    if not _darf_verwalten(gruppe, eigene_zeile):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not_allowed")
    if _rolle(gruppe, eigene_zeile) == "admin" and _rolle(gruppe, ziel_mitglied) != "mitglied":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="not_allowed")

    geloescht = await _entferne_mitglied(session, gruppe, user_id)
    if geloescht:
        return None
    mitglieder = await _mitglieder_laden(session, gruppe_id)
    return _wire(gruppe, mitglieder, user.id)


@router.post("/gruppen/{gruppe_id}/verlassen")
async def gruppe_verlassen(
    gruppe_id: int, session: SessionDep, user: CurrentUser
) -> PrivateGroupOut | None:
    gruppe, _ = await _gruppe_fuer_mitglied_laden(session, gruppe_id, user.id)
    geloescht = await _entferne_mitglied(session, gruppe, user.id)
    if geloescht:
        return None
    mitglieder = await _mitglieder_laden(session, gruppe_id)
    return _wire(gruppe, mitglieder, user.id)
