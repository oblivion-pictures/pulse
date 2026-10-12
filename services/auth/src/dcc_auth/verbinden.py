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
import logging
import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal

from pydantic import BaseModel
from redis.exceptions import RedisError, WatchError

#: Gültigkeit eines Codes in Sekunden (E1: 15 Minuten).
GUELTIG_S = 900
#: Abstand, in dem der Server abholen soll (5 s = 12 Abfragen je Minute). Die
#: Bremse in ``config.py`` (``rate_limit_verbinden_abholen``, 30 je Minute)
#: lässt das 2,5-Fache zu.
ABSTAND_S = 5

# Crockford-Base32: ohne I, L, O, U — nichts, was sich beim Abtippen mit einer
# Ziffer oder einem anderen Buchstaben verwechseln lässt.
_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_VERWECHSLUNG = str.maketrans({"O": "0", "I": "1", "L": "1"})
_CODE_LAENGE = 8
_PRAEFIX = "auth:verbinden:"

log = logging.getLogger(__name__)

#: ``uebernahme_*``: die Adresse gehört einem anderen Konto, und statt eines
#: Eintrags entstand ein Antrag bzw. greift eine Sperre (Widerspruchsfrist,
#: ``verbinden_uebernahme.py``). ``pulse-connect`` erfährt es beim Abholen.
Status = Literal["wartet", "bestaetigt", "abgelehnt", "uebernahme_beantragt", "uebernahme_gesperrt"]


class VorgangLaeuft(Exception):
    """Für diese Abholkennung läuft schon ein Vorgang für eine andere Adresse."""


class Vorgang(BaseModel):
    hostname: str
    code: str
    status: Status = "wartet"
    instance_id: str | None = None
    user_id: str | None = None
    gueltig_bis: str
    #: ISO 8601 — Fristende eines Übernahme-Antrags, bei ``uebernahme_gesperrt``
    #: das Sperrende. Mit Vorgabe, damit Vorgänge von vor dem Ausrollen lesbar
    #: bleiben.
    frist_bis: str | None = None
    #: Nur bei ``abgelehnt``, wenn die Cloud selbst abgelehnt hat und nicht der
    #: Mensch: ``verbinden_gesperrt`` oder ``instance_suspended``. ``abholen``
    #: reicht ihn an ``pulse-connect`` weiter. Bewusst ``str``, nicht ``Literal``:
    #: ein Wert, den dieser Stand nicht kennt, soll beim Lesen nicht werfen.
    grund: str | None = None
    #: Woran das Bestätigen zuletzt scheiterte, obwohl ein zweiter Klick helfen
    #: kann (``zu_viele_server``, ``nachweis_fehlt``). Gesetzt nur an einem
    #: wartenden Vorgang und nur dort gelesen; eine spätere Entscheidung lässt den
    #: Wert stehen, ``abholen`` gibt ihn dann nicht mehr aus.
    #: Ebenfalls mit Vorgabe und ohne ``Literal``, aus demselben Grund.
    hinweis: str | None = None


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
    frist_bis: str | None = None,
    grund: str | None = None,
) -> bool:
    """Setzt das Ergebnis, aber nur aus ``wartet`` heraus — ``True`` bei Erfolg.

    Ein Code wird genau einmal entschieden: Zwei Tabs, ein Doppelklick oder
    zwei Menschen, die denselben Code gesehen haben, ergeben genau einen
    Gewinner. Der Aufrufer committet seine Datenbank-Arbeit erst, wenn hier
    ``True`` kam. Die Frist läuft weiter (``KEEPTTL``).
    """
    schluessel = _vorgang_schluessel(nachweis)
    # Ein WatchError sagt nur, dass sich der Schlüssel zwischen Lesen und
    # Schreiben geändert hat. Meist hat ein anderer Klick entschieden: dann liest
    # der nächste Durchgang ``status != wartet`` und gibt auf. Hat dagegen nur ein
    # Hinweis geschrieben (``vorgang_hinweis_setzen``, ein zweiter Tab, dessen
    # Bestätigen gerade scheitert), wartet der Vorgang noch und darf entschieden
    # werden. Drei Durchgänge genügen dafür: Hinweise kommen nur aus Klicks.
    for _ in range(3):
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
                    update={
                        "status": status,
                        "instance_id": instance_id,
                        "user_id": user_id,
                        "frist_bis": frist_bis,
                        "grund": grund,
                    }
                )
                pipe.multi()
                pipe.set(schluessel, neu.model_dump_json(), xx=True, keepttl=True)
                await pipe.execute()
                return True
            except WatchError:
                continue
    return False


async def vorgang_hinweis_setzen(redis, nachweis: str, hinweis: str) -> bool:
    """Merkt am WARTENDEN Vorgang, woran das Bestätigen zuletzt scheiterte.

    Der Vorgang bleibt ``wartet`` — ein zweiter Klick ist erlaubt —, aber
    ``abholen`` kann es ``pulse-connect`` jetzt sagen, statt dass es 15 Minuten
    still wartet. Ändert nur einen wartenden Vorgang, atomar wie
    ``vorgang_entscheiden`` (``WATCH``/``MULTI``, die Frist läuft weiter); ein
    entschiedener oder verschwundener bleibt unberührt. ``True``, wenn danach
    ``hinweis`` am wartenden Vorgang steht.

    Eine Hilfe, kein Teil der Entscheidung: scheitert sie, macht der Aufrufer
    ohne Hinweis weiter. Deshalb wirft sie auch bei einem Redis-Fehler nicht.
    """
    schluessel = _vorgang_schluessel(nachweis)
    try:
        async with redis.pipeline(transaction=True) as pipe:
            try:
                await pipe.watch(schluessel)
                roh = await pipe.get(schluessel)
                if roh is None:
                    return False
                vorgang = Vorgang.model_validate_json(roh)
                if vorgang.status != "wartet":
                    return False
                if vorgang.hinweis == hinweis:
                    return True
                pipe.multi()
                pipe.set(
                    schluessel,
                    vorgang.model_copy(update={"hinweis": hinweis}).model_dump_json(),
                    xx=True,
                    keepttl=True,
                )
                await pipe.execute()
            except WatchError:
                return False  # ein anderer Aufruf war schneller
    except RedisError as fehler:
        # warning, weil ``info`` in der Cloud unsichtbar ist (logging_setup.py).
        log.warning("verbinden_hinweis_fehlgeschlagen fehler=%s", type(fehler).__name__)
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
