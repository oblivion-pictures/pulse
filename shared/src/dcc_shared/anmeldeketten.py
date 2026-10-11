"""Das Ende einer Anmelde-Kette — von auth-svc an den chat-gateway (iOS-Bughunt 2, C2).

**Warum es diese Nachricht gibt.** Ein Telefon meldet beim chat-gateway zwei
Gerätetoken an: den FCM-Token für Nachrichten-Banner und den PushKit-Token
fürs Klingeln. Bis zum 2026-10-11 lebten beide unabhängig von der Anmeldung
weiter: wurde die Sitzung eines verlorenen Telefons unter „Sitzungen beenden"
widerrufen, das Passwort zurückgesetzt oder das Konto gesperrt, zeigte das
Telefon weiter Banner mit Absendernamen und klingelte mit dem Namen des
Anrufers. Das Abmelden im Klienten half nicht — es läuft auf dem Gerät, das
gerade verloren ist.

**Woran sich ein Token einer Kette zuordnen lässt.** auth-svc stempelt die
Anmelde-Kette (``refresh_tokens.family_id``, Migration 0050) als Claim
``kette`` ins Zugriffs-Token; der chat-gateway legt ihn neben den Gerätetoken
ab, wenn das Telefon sie anmeldet. Die Kette überlebt jede Rotation und
beschreibt damit das Gerät, nicht den einzelnen Ausweis.

**Zwei Wege, weil einer allein nicht reicht** (Dienste teilen keine Tabellen):

1. **Die Meldung auf** ``KANAL`` (Redis Pub/Sub) — sofort, aber flüchtig. Ein
   Ereignis, das ankommt, während kein chat-gateway zuhört (Neustart beim
   Ausrollen, Aussetzer der Redis-Verbindung), geht verloren. Und eine Kette,
   die nur abläuft (30 Tage ohne Rotation), meldet niemand.
2. **Der Abgleich über** ``STAND_PFAD`` (seit 2026-10-11, Nachtrag zu C2). Der
   chat-gateway fragt auth-svc kurz nach dem Start und danach im festen Takt,
   welche Ketten seiner Zeilen zu Ende sind (``geraetetoken_abgleich.py``),
   und holt damit beides nach. auth-svc bleibt die einzige Quelle; der
   chat-gateway kennt nur die Kette an der Zeile. Ein Redis-Strom mit
   Quittung hätte nur die erste Lücke geschlossen, nicht die zweite.

Zwei Formen der Meldung:

* ``ketten`` — genau diese Ketten sind zu Ende (Abmelden, Sitzung beenden,
  Diebstahlsverdacht, Passwortwechsel für die übrigen Geräte).
* ``alle`` — jede Kette des Kontos ist zu Ende (Passwort-Reset, Sperre). Dann
  fallen auch Token ohne Kettenvermerk, die vor dieser Änderung angemeldet
  wurden. **Der Abgleich kennt diese Form nicht:** er fragt nur nach Zeilen
  MIT Kette. Eine Zeile ohne Vermerk bekommt ihre Kette beim nächsten
  App-Start; bis dahin fällt sie nur unter eine Meldung ``alle``, die ankommt.

**Wann der Abgleich eine Kette „zu Ende" nennt:** kein Refresh-Token der Kette
lebt mehr (widerrufen, abgelaufen oder gelöscht) **und** auth-svc kennt das
Konto. „Gelöscht" gehört dazu, weil der Passwortwechsel die Zeilen löscht,
statt sie zu widerrufen (``routes_account_security.py``) — eine Kette ohne
jede Zeile ist dort der Normalfall eines Endes. Die zweite Bedingung ist der
Riegel gegen ein falsches oder leeres auth-svc: wer dort nach Konten fragt,
die es nicht gibt, bekommt ``unbekannt`` zurück, und nichts wird gelöscht.

Anfrage ``{"ketten": [{"user_id": "7", "kette": "…"}]}`` (höchstens
``STAND_HOECHSTENS`` Paare), Antwort ``{"beendet": [Paare], "unbekannt": n}``.
Was die Antwort nicht als beendet nennt, bleibt stehen — dieselbe Richtung
wie bei einem Ausfall.
"""

from __future__ import annotations

import json
from collections.abc import Collection, Iterable
from dataclasses import dataclass

#: Redis-Kanal. auth-svc veröffentlicht, chat-gateway hört zu.
KANAL = "auth:ketten_ende"

#: Name des Claims im Zugriffs-Token.
CLAIM = "kette"

#: Interne Route am auth-svc für den Abgleich (``INTERNAL_SERVICE_SECRET``).
STAND_PFAD = "/internal/ketten/stand"

#: Höchstzahl der Paare je Abgleich-Anfrage; der chat-gateway stückelt.
STAND_HOECHSTENS = 500

#: ``(user_id, kette)`` — eine Kette gilt immer für genau ein Konto.
Paar = tuple[int, str]


@dataclass(frozen=True)
class KettenEnde:
    user_id: int
    ketten: frozenset[str]
    alle: bool = False


def nachricht(*, user_id: int, ketten: Iterable[object] = (), alle: bool = False) -> str | None:
    """Die Nachricht als JSON — oder ``None``, wenn sie nichts besagt.

    ``ketten`` nimmt, was die Zeilen tragen (``uuid.UUID`` oder Text); ``None``
    fällt heraus (Zeilen von vor Migration 0050 haben keine Kette).
    """
    namen = sorted({str(k) for k in ketten if k is not None})
    if not alle and not namen:
        return None
    return json.dumps({"user_id": str(user_id), "ketten": namen, "alle": alle})


def lesen(daten: object) -> KettenEnde | None:
    """Die Nachricht wieder auspacken; ``None`` für alles, was nicht passt."""
    if isinstance(daten, bytes | str):
        try:
            daten = json.loads(daten)
        except ValueError:
            return None
    if not isinstance(daten, dict):
        return None
    try:
        user_id = int(daten["user_id"])
    except (KeyError, TypeError, ValueError):
        return None
    ketten = daten.get("ketten", [])
    if not isinstance(ketten, list) or not all(isinstance(k, str) for k in ketten):
        return None
    return KettenEnde(user_id=user_id, ketten=frozenset(ketten), alle=daten.get("alle") is True)


# ---------------------------------------------------------------------------
# Abgleich (``STAND_PFAD``)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class KettenStand:
    """Was auth-svc über die gefragten Paare sagt."""

    #: Nachweislich zu Ende — diese Zeilen dürfen fallen.
    beendet: frozenset[Paar]
    #: Konto unbekannt: nichts gelöscht, nur gezählt (s. Modulkopf).
    unbekannt: int


def stand_anfrage(paare: Iterable[Paar]) -> dict[str, list[dict[str, str]]]:
    """Der Körper der Abgleich-Anfrage; die Konto-ID reist als Text wie überall."""
    return {"ketten": [{"user_id": str(u), "kette": k} for u, k in sorted(set(paare))]}


def _paar(eintrag: object) -> Paar | None:
    if not isinstance(eintrag, dict):
        return None
    user_id, kette = eintrag.get("user_id"), eintrag.get("kette")
    if not isinstance(user_id, str) or not user_id.isdecimal() or not isinstance(kette, str):
        return None
    return int(user_id), kette


def stand_lesen(daten: object, gefragt: Collection[Paar]) -> KettenStand | None:
    """Die Antwort auswerten — oder ``None``, wenn sie nicht passt.

    Ein einziger unlesbarer Eintrag verwirft die ganze Antwort: der Aufrufer
    löscht dann nichts. Nur gefragte Paare zählen; was auth-svc darüber hinaus
    nennt, wird übergangen.
    """
    if not isinstance(daten, dict):
        return None
    roh, unbekannt = daten.get("beendet"), daten.get("unbekannt")
    if not isinstance(roh, list) or type(unbekannt) is not int or unbekannt < 0:
        return None
    beendet: set[Paar] = set()
    for eintrag in roh:
        paar = _paar(eintrag)
        if paar is None:
            return None
        beendet.add(paar)
    return KettenStand(frozenset(beendet & set(gefragt)), unbekannt)


__all__ = [
    "CLAIM",
    "KANAL",
    "STAND_HOECHSTENS",
    "STAND_PFAD",
    "KettenEnde",
    "KettenStand",
    "Paar",
    "lesen",
    "nachricht",
    "stand_anfrage",
    "stand_lesen",
]
