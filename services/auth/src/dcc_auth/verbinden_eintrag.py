"""Server-Eintrag beim Verbinden per Gerätecode anlegen, wiederverwenden oder übernehmen.

Läuft, nachdem der Betreiber im Browser „Verbinden“ geklickt und die Cloud
den Nachweis unter der Adresse erneut geprüft hat (``routes_verbinden.py``).
Damit steht fest: unter dieser Adresse läuft gerade der Server, der den Code
angefragt hat. Daraus folgt die Regel (Spec
``docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md``, E2):

* eigener Eintrag unter der Adresse → wiederverwenden (Neuinstallation
  desselben Besitzers; Mitglieder und Nummer bleiben),
* fremder Eintrag → Soft-Delete wie ``routes_instance_delete.py`` und neu
  anlegen. Der alte Server steht über die Sperrliste still, falls er
  irgendwo noch läuft. Die Route ruft das bei einem fremden Eintrag erst
  nach abgelaufener Widerspruchsfrist auf (``verbinden_uebernahme.py``),
* gesperrter Eintrag → ``InstanzGesperrt``; ebenso ein gelöschter, der beim
  Löschen gesperrt war und deshalb seine Adresse hält,
* kein Eintrag → neu anlegen.

Committet nicht: der Aufrufer committet erst, wenn der Vorgang in Redis
tatsächlich entschieden ist (``verbinden.vorgang_entscheiden``).
"""

from __future__ import annotations

import asyncio
import secrets
from typing import NamedTuple

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from dcc_shared.hostname import normalisiere_hostname

from dcc_auth.config import Settings
from dcc_auth.models import User
from dcc_auth.models_instances import RegisteredInstance, UserInstanceMembership
from dcc_auth.routes_instance_delete import soft_delete_instance
from dcc_auth.security import hash_password
from dcc_auth.snowflake import next_id

#: Höchstens so viele verbundene gemietete Server je Konto (E8). Heim-Server
#: zählen nicht mit; für die gilt weiter einer je Konto.
HOECHSTENS_SERVER = 10


class ZuVieleServer(Exception):
    """Das Konto hat schon ``HOECHSTENS_SERVER`` aktive gemietete Server."""


class InstanzGesperrt(Exception):
    """Unter der Adresse steht ein gesperrter Eintrag.

    Ihn zu übernehmen hiesse, der Sperre durch Neuverbinden zu entkommen.
    Das gilt auch für einen gelöschten: der Besitzer darf eine gesperrte
    Instanz löschen, die Adresse bleibt dabei gesperrt (``geloeschte_adresse.py``).
    """


class Verbunden(NamedTuple):
    instanz: RegisteredInstance
    #: Kennung des per Übernahme gelöschten Eintrags — der Aufrufer muss nach
    #: dem Commit den Cache der Sperrliste leeren (``suspended_list_add``).
    abgeloest: int | None


def adresse_gesperrt(hostname: str, settings: Settings) -> bool:
    """Adressen unter den eigenen Domains bekommen keinen Eintrag.

    Sonst könnte jemand eine Relay-Subdomain belegen, bevor sie vergeben ist,
    oder einen Namen unter der Cloud-Domain für sich eintragen.
    """
    eigene = (
        normalisiere_hostname(settings.pulse_oidc_issuer),
        normalisiere_hostname(settings.pulse_relay_base_domain),
    )
    return any(d and (hostname == d or hostname.endswith("." + d)) for d in eigene)


async def aktive_gemietete_server(db: AsyncSession, user_id: int) -> int:
    """Die Zählung für ``HOECHSTENS_SERVER`` — öffentlich, weil der
    Übernahme-Antrag (``verbinden_uebernahme.py``) die Grenze schon vor dem
    Anlegen prüft und dabei genau so zählen muss wie der Vollzug hier."""
    return (
        await db.execute(
            select(func.count())
            .select_from(RegisteredInstance)
            .where(
                RegisteredInstance.registered_by == user_id,
                RegisteredInstance.status == "active",
                RegisteredInstance.origin == "vps",
            )
        )
    ).scalar_one()


async def eintrag_sperren(db: AsyncSession, hostname: str) -> RegisteredInstance | None:
    """Der Eintrag unter der Adresse, mit gesperrter Zeile.

    Die Übernahme-Prüfung (``verbinden_uebernahme.py``) und der Vollzug hier
    sperren damit dieselbe Zeile wie der Widerspruch (``routes_uebernahme.py``,
    über ``eigene_instanz_oder_404``) — so kreuzen sich die drei nicht.
    """
    ergebnis = await db.execute(
        select(RegisteredInstance).where(RegisteredInstance.hostname == hostname).with_for_update()
    )
    return ergebnis.scalars().first()


async def instanz_verbinden(db: AsyncSession, user: User, hostname: str) -> Verbunden:
    """Eintrag für ``hostname`` mit ``user`` als Besitzer — ohne Commit."""
    vorhanden = await eintrag_sperren(db, hostname)

    # Ein gelöschter Eintrag gilt wie ein gesperrter. Einen echten Hostnamen
    # trägt er nur, wenn er beim Löschen gesperrt war — jede andere Löschung
    # benennt ihn auf den Platzhalter um, unter dem ihn niemand mehr findet
    # (``soft_delete_instance``). Wäre dieser Fall frei, entkäme der Besitzer
    # der Sperre: löschen und die Adresse sofort neu verbinden.
    if vorhanden is not None and vorhanden.status in ("suspended", "deleted"):
        raise InstanzGesperrt
    if vorhanden is not None and vorhanden.registered_by == user.id:
        if await db.get(UserInstanceMembership, (user.id, vorhanden.id)) is None:
            db.add(UserInstanceMembership(user_id=user.id, instance_id=vorhanden.id, role="owner"))
        return Verbunden(vorhanden, None)

    if await aktive_gemietete_server(db, user.id) >= HOECHSTENS_SERVER:
        raise ZuVieleServer

    abgeloest: int | None = None
    if vorhanden is not None:
        await soft_delete_instance(db, vorhanden)
        abgeloest = vorhanden.id
        # Die Adresse muss frei sein, bevor der neue Eintrag sie belegt
        # (``hostname`` ist eindeutig).
        await db.flush()

    neu = RegisteredInstance(
        id=next_id(),
        hostname=hostname,
        client_id=secrets.token_urlsafe(16),
        # Platzhalter bis zum Abholen: ein echter Hash eines verworfenen
        # Zufallswerts. ``zugangsdaten_ausgeben`` rotiert ihn beim Abholen.
        client_secret=await asyncio.to_thread(hash_password, secrets.token_urlsafe(32)),
        status="active",
        origin="vps",
        registered_by=user.id,
        ohne_freigabe=True,
    )
    db.add(neu)
    db.add(UserInstanceMembership(user_id=user.id, instance_id=neu.id, role="owner"))
    await db.flush()
    return Verbunden(neu, abgeloest)
