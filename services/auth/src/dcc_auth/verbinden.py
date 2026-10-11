"""Gerätecode und Vorgang beim Verbinden eines Servers mit einem Konto.

Ablauf nach dem Muster „Device Authorization Grant“ (RFC 8628; Spec
``docs/superpowers/specs/2026-10-09-selfhost-ohne-freigabe-design.md``, E1):
Der Server fragt einen Code an, der Betreiber bestätigt ihn im Browser, der
Server holt danach mit seiner geheimen Abholkennung die Zugangsdaten ab.

Der Vorgang lebt nur in Redis, 15 Minuten lang, unter zwei Schlüsseln:

* ``auth:verbinden:vorgang:<nachweis>`` — der Zustand (JSON, ``Vorgang``).
  Der Nachweis ist der SHA-256 der Abholkennung. Die Kennung selbst speichert
  die Cloud nie; wer nur den Speicher sieht, kann nichts abholen.
* ``auth:verbinden:code:<code>`` — Verweis vom Anzeigecode auf den Nachweis,
  damit die Bestätigungsseite den Vorgang findet.

Kein Datenbank-Eintrag: ein nie bestätigter Code hinterlässt nichts, und die
Frist erledigt Redis selbst.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal

from pydantic import BaseModel
from redis.exceptions import WatchError

#: Gültigkeit eines Codes in Sekunden (E1: 15 Minuten).
GUELTIG_S = 900
#: Abstand, in dem der Server abholen soll. Die Bremse in ``config.py``
#: (``rate_limit_verbinden_abholen``) lässt das Doppelte zu.
ABSTAND_S = 5

# Crockford-Base32: ohne I, L, O, U — nichts, was sich beim Abtippen mit einer
# Ziffer oder einem anderen Buchstaben verwechseln lässt.
_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_VERWECHSLUNG = str.maketrans({"O": "0", "I": "1", "L": "1"})
_CODE_LAENGE = 8
_PRAEFIX = "auth:verbinden:"

Status = Literal["wartet", "bestaetigt", "abgelehnt"]


class VorgangLaeuft(Exception):
    """Für diese Abholkennung läuft schon ein Vorgang für eine andere Adresse."""


class Vorgang(BaseModel):
    hostname: str
    code: str
    status: Status = "wartet"
    instance_id: str | None = None
    user_id: str | None = None
    gueltig_bis: str


def _vorgang_schluessel(nachweis: str) -> str:
    return f"{_PRAEFIX}vorgang:{nachweis}"


def _code_schluessel(code: str) -> str:
    return f"{_PRAEFIX}code:{code}"


def neuer_code() -> str:
    """Acht Zeichen, 40 Bit — genug für 15 Minuten bei gebremstem Raten."""
    return "".join(secrets.choice(_ALPHABET) for _ in range(_CODE_LAENGE))


def code_anzeigen(code: str) -> str:
    return f"{code[:4]}-{code[4:]}"


def code_normalisieren(roh: str) -> str | None:
    """Die Eingabe des Betreibers in die Speicherform, oder ``None``.

    Groß/klein, Leerraum und Bindestriche sind egal; ``O``/``I``/``L`` werden
    als die Ziffern gelesen, mit denen man sie verwechselt.
    """
    code = "".join(roh.split()).replace("-", "").upper().translate(_VERWECHSLUNG)
    if len(code) != _CODE_LAENGE or any(z not in _ALPHABET for z in code):
        return None
    return code


def nachweis_aus_kennung(kennung: str) -> str:
    return hashlib.sha256(kennung.encode()).hexdigest()


async def vorgang_per_nachweis(redis, nachweis: str) -> Vorgang | None:
    roh = await redis.get(_vorgang_schluessel(nachweis))
    return Vorgang.model_validate_json(roh) if roh is not None else None


async def vorgang_anlegen(redis, hostname: str, nachweis: str) -> Vorgang:
    """Legt den Vorgang an; ein wiederholter Start liefert den laufenden.

    Wiederholt heisst: dieselbe Kennung für dieselbe Adresse, noch nicht
    entschieden — der Server hat nach einem Netzfehler noch einmal gefragt.
    Sonst wird nichts überschrieben (``VorgangLaeuft``): ein zweiter Aufruf
    könnte einen schon gezeigten Code still entwerten oder ein Ergebnis
    zurücksetzen, das noch auf das Abholen wartet.
    """
    laufend = await vorgang_per_nachweis(redis, nachweis)
    if laufend is not None:
        if laufend.hostname != hostname or laufend.status != "wartet":
            raise VorgangLaeuft
        return laufend

    # Zwei gleichzeitige Vorgänge mit demselben Code dürfen nicht entstehen:
    # die Bestätigungsseite fände sonst den falschen Server.
    for _ in range(5):
        code = neuer_code()
        if await redis.set(_code_schluessel(code), nachweis, ex=GUELTIG_S, nx=True):
            break
    else:
        raise RuntimeError("kein freier Gerätecode gefunden")

    ende = datetime.now(UTC).replace(microsecond=0) + timedelta(seconds=GUELTIG_S)
    vorgang = Vorgang(hostname=hostname, code=code, gueltig_bis=ende.isoformat())
    if not await redis.set(
        _vorgang_schluessel(nachweis), vorgang.model_dump_json(), ex=GUELTIG_S, nx=True
    ):
        # Ein gleichzeitiger Start mit derselben Kennung war schneller.
        await redis.delete(_code_schluessel(code))
        raise VorgangLaeuft
    return vorgang


async def vorgang_per_code(redis, code: str) -> tuple[str, Vorgang] | None:
    """``code`` in Speicherform (``code_normalisieren``)."""
    nachweis = await redis.get(_code_schluessel(code))
    if nachweis is None:
        return None
    vorgang = await vorgang_per_nachweis(redis, nachweis)
    if vorgang is None or vorgang.code != code:
        return None
    return nachweis, vorgang


async def vorgang_entscheiden(
    redis,
    nachweis: str,
    status: Status,
    *,
    instance_id: str | None,
    user_id: str | None,
) -> bool:
    """Setzt das Ergebnis, aber nur aus ``wartet`` heraus — ``True`` bei Erfolg.

    Ein Code wird genau einmal entschieden: Zwei Tabs, ein Doppelklick oder
    zwei Menschen, die denselben Code gesehen haben, ergeben genau einen
    Gewinner. Der Aufrufer committet seine Datenbank-Arbeit erst, wenn hier
    ``True`` kam. Die Frist läuft weiter (``KEEPTTL``).
    """
    schluessel = _vorgang_schluessel(nachweis)
    async with redis.pipeline(transaction=True) as pipe:
        try:
            await pipe.watch(schluessel)
            roh = await pipe.get(schluessel)
            if roh is None:
                return False
            vorgang = Vorgang.model_validate_json(roh)
            if vorgang.status != "wartet":
                return False
            neu = vorgang.model_copy(
                update={"status": status, "instance_id": instance_id, "user_id": user_id}
            )
            pipe.multi()
            pipe.set(schluessel, neu.model_dump_json(), xx=True, keepttl=True)
            await pipe.execute()
        except WatchError:
            return False
    return True


async def vorgang_entnehmen(redis, nachweis: str) -> Vorgang | None:
    """Holt den Vorgang und löscht beide Schlüssel; gelingt genau einem Aufrufer.

    ``GETDEL`` ist atomar — zwei gleichzeitige Abholungen bekommen nie beide
    Zugangsdaten.
    """
    roh = await redis.getdel(_vorgang_schluessel(nachweis))
    if roh is None:
        return None
    vorgang = Vorgang.model_validate_json(roh)
    await redis.delete(_code_schluessel(vorgang.code))
    return vorgang
