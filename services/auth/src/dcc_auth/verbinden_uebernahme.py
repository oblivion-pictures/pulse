"""Widerspruchsfrist, bevor ein fremdes Konto eine eingetragene Adresse übernimmt.

Spec ``docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md``,
E2, Nachtrag 2026-10-11. Den Nachweis unter einer Adresse besteht auch, wer die
DNS-Einträge einer fremden Domain ein paar Minuten lang kontrolliert. Damit ein
so kurzer Angriff nicht dauerhaft wird, legt das Bestätigen durch ein fremdes
Konto nur einen Antrag an:

* Frist 72 Stunden. Danach ruft der neue Betreiber ``pulse-connect`` erneut
  auf, die Cloud prüft den Nachweis noch einmal, und erst dann übernimmt
  ``instanz_verbinden``.
* Widerspricht der bisherige Besitzer (``routes_uebernahme.py``), kann 30 Tage
  lang kein fremdes Konto die Adresse beanspruchen.
* Ein Antrag verfällt 7 Tage nach Fristende (Vorgabe des Plans).

Begriffe: **offen** = weder widersprochen noch vollzogen noch verfallen;
**lebendig** = offen, der Antragsteller hat sein Konto nicht gelöscht, und der
Verfall ist nicht erreicht; **fällig** = lebendig und die Frist ist um.

Der Antrag hängt an der alten Instanz, nicht an der Adresse. Committet wird
hier nichts — das tut die Route, wenn der Vorgang in Redis entschieden ist.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_auth.config import get_settings
from dcc_auth.models import User
from dcc_auth.models_instances import InstanzUebernahme, RegisteredInstance
from dcc_auth.snowflake import next_id
from dcc_auth.verbinden_eintrag import (
    HOECHSTENS_SERVER,
    ZuVieleServer,
    aktive_gemietete_server,
)

#: So oft liest ``uebernahme_pruefen`` nach einem gleichzeitig geschriebenen
#: Antrag neu. Schon der zweite Durchlauf sieht den fremden Antrag und schreibt
#: selbst nichts mehr; der dritte ist Reserve.
_VERSUCHE = 3

_OFFEN = (
    InstanzUebernahme.widersprochen_at.is_(None),
    InstanzUebernahme.vollzogen_at.is_(None),
    InstanzUebernahme.verfallen_at.is_(None),
)


def _jetzt() -> datetime:
    """Ganze Sekunden: Fristen reisen als ISO-Text bis in die Konsole des
    Betreibers. Tests stellen hier die Uhr vor."""
    return datetime.now(UTC).replace(microsecond=0)


def _utc(dt: datetime) -> datetime:
    """SQLite liefert naive Werte zurück (Muster ``refresh_kette.py``)."""
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


class UebernahmeBeantragt(Exception):
    """Statt eines Eintrags steht ein Antrag. Nur bei ``neu`` geht die Mail an
    den bisherigen Besitzer."""

    def __init__(
        self, alte_instanz_id: int, besitzer_id: int | None, frist_bis: datetime, neu: bool
    ) -> None:
        super().__init__(alte_instanz_id)
        self.alte_instanz_id = alte_instanz_id
        self.besitzer_id = besitzer_id
        self.frist_bis = frist_bis
        self.neu = neu


class UebernahmeGesperrt(Exception):
    """Kein fremdes Konto bis ``bis``: nach einem Widerspruch dessen Zeitpunkt
    plus Sperre, bei einem lebendigen Antrag eines anderen Kontos dessen
    Fristende plus Verfall."""

    def __init__(self, bis: datetime) -> None:
        super().__init__(bis)
        self.bis = bis


def _offen(antrag: InstanzUebernahme) -> bool:
    return (
        antrag.widersprochen_at is None
        and antrag.vollzogen_at is None
        and antrag.verfallen_at is None
    )


def _lebendig(antrag: InstanzUebernahme, jetzt: datetime, verfall: timedelta) -> bool:
    # Hat der Antragsteller sein Konto gelöscht (SET NULL), wartet niemand mehr.
    return (
        _offen(antrag)
        and antrag.neues_konto_id is not None
        and jetzt < _utc(antrag.frist_bis) + verfall
    )


async def uebernahme_pruefen(db: AsyncSession, user: User, hostname: str, settings) -> None:
    """Darf ``instanz_verbinden`` für ``user`` unter ``hostname`` laufen?

    Kehrt zurück, wenn ja: Adresse frei, eigener Eintrag, gesperrter Eintrag
    (dort wirft ``instanz_verbinden`` selbst) oder ein fälliger Antrag dieses
    Kontos gegen genau diesen Eintrag. Sonst ``UebernahmeGesperrt``,
    ``UebernahmeBeantragt`` oder ``ZuVieleServer``. Ohne Commit.
    """
    user_id = user.id
    for _ in range(_VERSUCHE - 1):
        try:
            return await _pruefen(db, user_id, hostname, settings)
        except IntegrityError:
            # Eine gleichzeitige Bestätigung hat ihren Antrag zuerst
            # geschrieben (ein offener je Instanz). Neu gelesen gilt dann
            # deren Antrag.
            await db.rollback()
            # Das Zurückrollen lässt alles Geladene verfallen; der Aufrufer
            # braucht ``user`` danach noch.
            await db.refresh(user)
    return await _pruefen(db, user_id, hostname, settings)


async def _pruefen(db: AsyncSession, user_id: int, hostname: str, settings) -> None:
    jetzt = _jetzt()
    verfall = timedelta(seconds=settings.verbinden_uebernahme_verfall_s)
    # Dieselbe Zeile sperren der Vollzug (``instanz_verbinden``) und der
    # Widerspruch — so kreuzen sich die beiden nicht.
    eintrag = (
        await db.execute(
            select(RegisteredInstance)
            .where(RegisteredInstance.hostname == hostname)
            .with_for_update()
        )
    ).scalars().first()
    if eintrag is None or eintrag.status != "active" or eintrag.registered_by == user_id:
        return

    antraege = (
        await db.execute(
            select(InstanzUebernahme).where(InstanzUebernahme.alte_instanz_id == eintrag.id)
        )
    ).scalars().all()
    lebendig = next((a for a in antraege if _lebendig(a, jetzt, verfall)), None)
    eigener = lebendig is not None and lebendig.neues_konto_id == user_id
    if eigener and jetzt >= _utc(lebendig.frist_bis):
        return

    for antrag in antraege:
        if _offen(antrag) and antrag is not lebendig:
            antrag.verfallen_at = jetzt
    widerspruch = max(
        (_utc(a.widersprochen_at) for a in antraege if a.widersprochen_at is not None),
        default=None,
    )
    if widerspruch is not None:
        sperre_bis = widerspruch + timedelta(seconds=settings.verbinden_uebernahme_sperre_s)
        if jetzt < sperre_bis:
            raise UebernahmeGesperrt(sperre_bis)
    if lebendig is not None and not eigener:
        raise UebernahmeGesperrt(_utc(lebendig.frist_bis) + verfall)
    if lebendig is not None:
        raise UebernahmeBeantragt(
            eintrag.id, eintrag.registered_by, _utc(lebendig.frist_bis), neu=False
        )

    # Vor dem Anlegen: ein Antrag, der beim Vollzug an der Grenze scheiterte,
    # hätte dem bisherigen Besitzer nur eine grundlose Mail geschickt.
    if await aktive_gemietete_server(db, user_id) >= HOECHSTENS_SERVER:
        raise ZuVieleServer
    frist_bis = jetzt + timedelta(seconds=settings.verbinden_uebernahme_frist_s)
    db.add(
        InstanzUebernahme(
            id=next_id(),
            alte_instanz_id=eintrag.id,
            hostname=hostname,
            neues_konto_id=user_id,
            beantragt_at=jetzt,
            frist_bis=frist_bis,
        )
    )
    await db.flush()
    raise UebernahmeBeantragt(eintrag.id, eintrag.registered_by, frist_bis, neu=True)


async def _lebendige(db: AsyncSession, instanz_ids: list[int]) -> dict[int, InstanzUebernahme]:
    if not instanz_ids:
        return {}
    jetzt = _jetzt()
    verfall = timedelta(seconds=get_settings().verbinden_uebernahme_verfall_s)
    offene = (
        await db.execute(
            select(InstanzUebernahme).where(
                InstanzUebernahme.alte_instanz_id.in_(instanz_ids), *_OFFEN
            )
        )
    ).scalars()
    return {a.alte_instanz_id: a for a in offene if _lebendig(a, jetzt, verfall)}


async def lebendige_uebernahme(db: AsyncSession, instanz_id: int) -> InstanzUebernahme | None:
    """Der lebendige Antrag gegen diese Instanz, falls es einen gibt."""
    return (await _lebendige(db, [instanz_id])).get(instanz_id)


async def uebernahme_fristen(db: AsyncSession, instanz_ids: list[int]) -> dict[int, str]:
    """Fristende (ISO 8601) je Instanz mit lebendigem Antrag — für „Meine
    Server“, in einer Abfrage statt einer je Eintrag."""
    return {
        iid: _utc(antrag.frist_bis).isoformat()
        for iid, antrag in (await _lebendige(db, instanz_ids)).items()
    }


async def uebernahme_vollzogen(db: AsyncSession, alte_instanz_id: int) -> None:
    """Setzt ``vollzogen_at`` am fälligen Antrag; keiner da: nichts zu tun.
    Ohne Commit."""
    antrag = await lebendige_uebernahme(db, alte_instanz_id)
    jetzt = _jetzt()
    if antrag is not None and jetzt >= _utc(antrag.frist_bis):
        antrag.vollzogen_at = jetzt


async def widersprechen(db: AsyncSession, instanz: RegisteredInstance) -> bool:
    """Setzt ``widersprochen_at`` am lebendigen Antrag; ``False``, wenn keiner
    lebt. Fragt frisch ab, der Aufrufer hält die Zeile der Instanz gesperrt.
    Ohne Commit."""
    antrag = await lebendige_uebernahme(db, instanz.id)
    if antrag is None:
        return False
    antrag.widersprochen_at = _jetzt()
    return True


async def adresse_vergeben(db: AsyncSession, hostname: str, user_id: int) -> bool:
    """Steht unter der Adresse ein aktiver Eintrag, der nicht diesem Konto
    gehört — auch einer ohne Besitzer?"""
    treffer = (
        await db.execute(
            select(RegisteredInstance.registered_by).where(
                RegisteredInstance.hostname == hostname,
                RegisteredInstance.status == "active",
            )
        )
    ).first()
    return treffer is not None and treffer.registered_by != user_id
